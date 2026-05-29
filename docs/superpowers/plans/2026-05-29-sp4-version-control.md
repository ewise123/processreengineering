# SP-4 Version Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the placeholder Versions tab into a working history — a graphical version tree with branch, restore, and a structured diff between two versions.

**Architecture:** A `ProcessVersion` is already a full graph snapshot (lanes/nodes/edges FK `version_id`, claim links on nodes/edges) with a `parent_version_id` self-FK tree. We add a dedicated `versions.py` router (mirroring SP-3's `reviews.py` split) with three endpoints: list (with counts), copy (one transaction backing both Branch and Restore — non-destructive, preserves claim links), and diff. Node identity across versions comes from a `_lineage_id` stamped into the existing unused `ProcessNode.properties` JSONB — **no migration**. The frontend rewrites `VersionsTab` to render a compact commit-graph rail and wires copy → navigate via `useRouter`.

**Tech Stack:** FastAPI + SQLAlchemy (backend), pytest; Next.js 16 + React 19 + TypeScript + @tanstack/react-query (frontend), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-29-sp4-version-control-design.md`

**Conventions for every commit in this plan:**
- Commit messages end with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Backend tests run from `backend/`: `cd backend && pytest tests/test_version_control.py -v`
- Frontend gates run from repo root: `npx tsc --noEmit`, `npm test`, `npm run build`
- Do **not** push; commit locally only. Do **not** use `rm`/`git rm`.

---

## File structure

**Backend**
- `backend/app/schemas/version.py` — **new.** `VersionSummaryRead`, `VersionCopyRequest`, and the diff schemas (`NodeChange`, `EdgeChange`, `LaneChange`, `NodeDiff`, `EdgeDiff`, `LaneDiff`, `VersionDiffRead`).
- `backend/app/api/v2/versions.py` — **new.** Router with `GET versions`, `POST copy`, `GET diff` + helpers.
- `backend/app/api/v2/__init__.py` — **modify.** Register the router.
- `backend/app/api/v2/process_maps.py` — **modify.** Stamp `_lineage_id` in `generate_process_map` and `create_node`.
- `backend/tests/test_version_control.py` — **new.** Integration tests.

**Frontend**
- `src/lib/types.ts` — **modify.** `VersionSummary`, `VersionDiff` (+ nested change types).
- `src/lib/api.ts` — **modify.** `listVersions`, `copyVersion`, `getVersionDiff`.
- `src/components/canvas/version-tree.ts` (+ `.test.ts`) — **new.** Pure tree/column helper.
- `src/components/canvas/version-diff.ts` (+ `.test.ts`) — **new.** Pure diff-summary helper.
- `src/components/canvas/right-panel.tsx` — **modify.** `VersionsTab` rewrite + `onNavigateVersion` prop threading.
- `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — **modify.** `useRouter`, navigation handler, pass `onNavigateVersion`.

---

## Task 1: Backend — version schemas + `GET versions` (list with counts)

**Files:**
- Create: `backend/app/schemas/version.py`
- Create: `backend/app/api/v2/versions.py`
- Modify: `backend/app/api/v2/__init__.py`
- Test: `backend/tests/test_version_control.py`

- [ ] **Step 1: Write the schemas**

Create `backend/app/schemas/version.py`:

```python
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class VersionSummaryRead(BaseModel):
    id: UUID
    version_number: int
    parent_version_id: UUID | None
    status: str
    notes: str | None
    created_at: datetime
    node_count: int
    lane_count: int
    edge_count: int


class VersionCopyRequest(BaseModel):
    note: str | None = None


class NodeChange(BaseModel):
    name: str
    from_name: str | None = None
    from_lane: str | None = None
    to_lane: str | None = None


class EdgeChange(BaseModel):
    source: str
    target: str


class LaneChange(BaseModel):
    name: str


class NodeDiff(BaseModel):
    added: list[NodeChange]
    removed: list[NodeChange]
    renamed: list[NodeChange]
    moved: list[NodeChange]
    unchanged_count: int


class EdgeDiff(BaseModel):
    added: list[EdgeChange]
    removed: list[EdgeChange]


class LaneDiff(BaseModel):
    added: list[LaneChange]
    removed: list[LaneChange]


class VersionDiffRead(BaseModel):
    nodes: NodeDiff
    edges: EdgeDiff
    lanes: LaneDiff
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_version_control.py`:

```python
"""Integration tests for SP-4 version control."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.factory import create_app
from app.db.session import get_db
from app.enums import ReviewTargetType
from app.models.identity import Organization, User
from app.models.process import (
    NodeClaimLink,
    ProcessEdge,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.project import Project
from app.models.workflow import Review


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed(db, n_nodes=2):
    """One model, one version (v1), two lanes, n_nodes nodes, 1 edge."""
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    model = ProcessModel(project_id=proj.id, name="m", level="L1"); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(version); db.flush()
    laneA = ProcessLane(version_id=version.id, name="Lane A", order_index=0)
    laneB = ProcessLane(version_id=version.id, name="Lane B", order_index=1)
    db.add_all([laneA, laneB]); db.flush()
    nodes = []
    for i in range(n_nodes):
        nd = ProcessNode(
            version_id=version.id, lane_id=laneA.id, type="task",
            name=f"n{i}", position={}, properties={},
        )
        db.add(nd); nodes.append(nd)
    db.flush()
    edge = ProcessEdge(
        version_id=version.id,
        source_node_id=nodes[0].id,
        target_node_id=nodes[1].id,
        label=None,
    )
    db.add(edge); db.flush(); db.commit()
    return proj, model, version, [laneA, laneB], nodes


def _versions_url(proj, model):
    return f"/api/v2/projects/{proj.id}/process-maps/{model.id}/versions"


def test_list_versions_with_counts(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    resp = client.get(_versions_url(proj, model))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    row = body[0]
    assert row["version_number"] == 1
    assert row["parent_version_id"] is None
    assert row["node_count"] == 2
    assert row["lane_count"] == 2
    assert row["edge_count"] == 1
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && pytest tests/test_version_control.py::test_list_versions_with_counts -v`
Expected: FAIL — 404 (route not registered yet).

- [ ] **Step 4: Implement the router + list endpoint**

Create `backend/app/api/v2/versions.py`:

```python
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
from app.schemas.version import (
    EdgeChange,
    EdgeDiff,
    LaneChange,
    LaneDiff,
    NodeChange,
    NodeDiff,
    VersionCopyRequest,
    VersionDiffRead,
    VersionSummaryRead,
)

router = APIRouter(prefix="/projects/{project_id}", tags=["versions"])

LINEAGE_KEY = "_lineage_id"


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
```

Register in `backend/app/api/v2/__init__.py`: add `versions` to the import tuple and `router.include_router(versions.router)`:

```python
from app.api.v2 import (
    claims,
    embeddings,
    inputs,
    process_detection,
    process_maps,
    projects,
    reviews,
    versions,
)
...
router.include_router(reviews.router)
router.include_router(versions.router)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && pytest tests/test_version_control.py::test_list_versions_with_counts -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas/version.py backend/app/api/v2/versions.py backend/app/api/v2/__init__.py backend/tests/test_version_control.py
git commit -m "$(cat <<'EOF'
feat(sp4): versions list endpoint with node/lane/edge counts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend — `POST copy` (branch/restore) + lineage stamping

**Files:**
- Modify: `backend/app/api/v2/versions.py`
- Modify: `backend/app/api/v2/process_maps.py` (stamp lineage on create)
- Test: `backend/tests/test_version_control.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_version_control.py` (`Review`, `ReviewTargetType`, `NodeClaimLink`, and `select` are already imported in the header from Task 1):

```python
def _copy_url(proj, model, version):
    return f"{_versions_url(proj, model)}/{version.id}/copy"


def test_copy_creates_new_version_snapshot(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    r = client.post(_copy_url(proj, model, version), json={"note": "Branched from v1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version_number"] == 2
    assert body["status"] == "draft"
    assert body["notes"] == "Branched from v1"
    new_id = body["id"]
    # The new version is parented on the source.
    new_version = db.get(ProcessVersion, new_id)
    assert str(new_version.parent_version_id) == str(version.id)
    # Graph copied: same lane/node/edge counts.
    listing = client.get(_versions_url(proj, model)).json()
    by_num = {row["version_number"]: row for row in listing}
    assert by_num[2]["node_count"] == 2
    assert by_num[2]["lane_count"] == 2
    assert by_num[2]["edge_count"] == 1


def test_copy_preserves_claim_links(client, db):
    from app.models.claim import Claim

    proj, model, version, lanes, nodes = _seed(db)
    claim = Claim(project_id=proj.id, kind="fact", subject="c")
    db.add(claim); db.flush()
    db.add(NodeClaimLink(node_id=nodes[0].id, claim_id=claim.id))
    db.commit()

    r = client.post(_copy_url(proj, model, version), json={})
    assert r.status_code == 200, r.text
    new_id = r.json()["id"]
    new_nodes = db.scalars(
        select(ProcessNode).where(ProcessNode.version_id == new_id)
    ).all()
    links = db.scalars(
        select(NodeClaimLink).where(
            NodeClaimLink.node_id.in_([n.id for n in new_nodes])
        )
    ).all()
    assert len(links) == 1
    assert str(links[0].claim_id) == str(claim.id)


def test_copy_seeds_and_inherits_lineage(client, db):
    proj, model, version, lanes, nodes = _seed(db)  # pre-lineage nodes (no _lineage_id)
    src_node_id = str(nodes[0].id)

    # First copy seeds lineage from the source node's own id.
    r1 = client.post(_copy_url(proj, model, version), json={})
    v2_id = r1.json()["id"]
    v2_nodes = db.scalars(select(ProcessNode).where(ProcessNode.version_id == v2_id)).all()
    seeded = {n.name: n.properties.get("_lineage_id") for n in v2_nodes}
    assert seeded["n0"] == src_node_id  # seeded with source id

    # Second copy (branch off v2) inherits the same lineage id, unchanged.
    v2 = db.get(ProcessVersion, v2_id)
    r2 = client.post(_copy_url(proj, model, v2), json={})
    v3_id = r2.json()["id"]
    v3_nodes = db.scalars(select(ProcessNode).where(ProcessNode.version_id == v3_id)).all()
    inherited = {n.name: n.properties.get("_lineage_id") for n in v3_nodes}
    assert inherited["n0"] == src_node_id  # stable across copies


def test_restore_parents_on_old_version(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    # Branch to v2 so v1 is no longer the latest.
    client.post(_copy_url(proj, model, version), json={})
    # "Restore v1" = copy from v1 again → v3 parented on v1.
    r = client.post(_copy_url(proj, model, version), json={"note": "Restored from v1"})
    assert r.json()["version_number"] == 3
    v3 = db.get(ProcessVersion, r.json()["id"])
    assert str(v3.parent_version_id) == str(version.id)


def test_copy_404_for_foreign_version(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    proj2, model2, version2, _, _ = _seed(db)
    # version2 belongs to model2, not model.
    r = client.post(_copy_url(proj, model, version2), json={})
    assert r.status_code == 404, r.text


def test_copy_has_fresh_review_slate(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    # Approve a node on v1 (per-node Review row keyed by node id).
    db.add(Review(
        project_id=proj.id,
        target_type=ReviewTargetType.PROCESS_NODE.value,
        target_id=nodes[0].id,
        status="approved",
    ))
    db.commit()
    r = client.post(_copy_url(proj, model, version), json={})
    new_id = r.json()["id"]
    new_nodes = db.scalars(select(ProcessNode).where(ProcessNode.version_id == new_id)).all()
    reviews = db.scalars(
        select(Review).where(
            Review.target_type == ReviewTargetType.PROCESS_NODE.value,
            Review.target_id.in_([n.id for n in new_nodes]),
        )
    ).all()
    assert reviews == []  # new node ids → no carried-over decisions
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && pytest tests/test_version_control.py -k copy -v`
Expected: FAIL — copy route 404 / not implemented.

- [ ] **Step 3: Implement the copy endpoint**

Append to `backend/app/api/v2/versions.py`:

```python
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
    node_links = db.scalars(
        select(NodeClaimLink).where(NodeClaimLink.node_id.in_(list(node_map.keys())))
    ).all() if node_map else []
    for link in node_links:
        db.add(NodeClaimLink(
            node_id=node_map[link.node_id],
            claim_id=link.claim_id,
            link_kind=link.link_kind,
        ))

    # Edge claim links
    edge_links = db.scalars(
        select(EdgeClaimLink).where(EdgeClaimLink.edge_id.in_(list(edge_map.keys())))
    ).all() if edge_map else []
    for link in edge_links:
        db.add(EdgeClaimLink(
            edge_id=edge_map[link.edge_id],
            claim_id=link.claim_id,
            link_kind=link.link_kind,
        ))

    db.commit()
    db.refresh(new_version)
    return new_version
```

- [ ] **Step 4: Stamp lineage on first node creation**

In `backend/app/api/v2/process_maps.py`, `create_node` (around line 497–507), replace the create-and-commit block so the node's own id seeds its lineage:

```python
    node = ProcessNode(
        version_id=version.id,
        type=payload.type,
        name=payload.name,
        lane_id=payload.lane_id,
        position={"x": payload.x, "relative_y": payload.relative_y},
        properties={},
    )
    db.add(node)
    db.flush()
    node.properties = {**node.properties, "_lineage_id": str(node.id)}
    db.commit()
    db.refresh(node)
    return node
```

In `generate_process_map`, after the existing `db.flush()` at the end of the node-creation loop (line ~304), stamp every freshly-created node:

```python
    db.flush()
    for node in node_by_external_id.values():
        node.properties = {**(node.properties or {}), "_lineage_id": str(node.id)}
    db.flush()
```

(Place this immediately after the existing `db.flush()` on line 304, before the edge-derivation comment on line 306.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && pytest tests/test_version_control.py -v`
Expected: PASS (all copy + list tests).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v2/versions.py backend/app/api/v2/process_maps.py backend/tests/test_version_control.py
git commit -m "$(cat <<'EOF'
feat(sp4): copy-version endpoint (branch/restore) with lineage + provenance

Non-destructive snapshot of a source version into a new version; copies
lanes/nodes/edges + node/edge claim links, seeds/inherits node _lineage_id,
parents the new version on the source. Stamps lineage on first node create.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Backend — `GET diff` between two versions

**Files:**
- Modify: `backend/app/api/v2/versions.py`
- Test: `backend/tests/test_version_control.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_version_control.py`:

```python
def _diff_url(proj, model, vfrom, vto):
    # Distinct path (`version-diff`, not `versions/diff`) so it can't be
    # shadowed by the existing GET `/versions/{version_id}` graph route.
    return (
        f"/api/v2/projects/{proj.id}/process-maps/{model.id}"
        f"/version-diff?from={vfrom}&to={vto}"
    )


def test_diff_detects_renamed_moved_added_removed(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    laneA, laneB = lanes
    # Stamp lineage on v1 nodes so the diff can track identity.
    for n in nodes:
        n.properties = {**n.properties, "_lineage_id": str(n.id)}
    db.commit()

    # Copy v1 -> v2, then mutate v2: rename n0, move n1 to lane B, add a node.
    v2_id = client.post(_copy_url(proj, model, version), json={}).json()["id"]
    v2_nodes = {n.name: n for n in db.scalars(
        select(ProcessNode).where(ProcessNode.version_id == v2_id)
    ).all()}
    v2_lanes = {l.name: l for l in db.scalars(
        select(ProcessLane).where(ProcessLane.version_id == v2_id)
    ).all()}
    v2_nodes["n0"].name = "n0-renamed"
    v2_nodes["n1"].lane_id = v2_lanes["Lane B"].id
    # add a brand-new node (no shared lineage)
    db.add(ProcessNode(
        version_id=v2_id, lane_id=v2_lanes["Lane A"].id, type="task",
        name="n2-new", position={}, properties={"_lineage_id": "brand-new"},
    ))
    db.commit()

    d = client.get(_diff_url(proj, model, version.id, v2_id)).json()
    renamed = {c["name"]: c for c in d["nodes"]["renamed"]}
    assert "n0-renamed" in renamed
    assert renamed["n0-renamed"]["from_name"] == "n0"
    moved = {c["name"]: c for c in d["nodes"]["moved"]}
    assert moved["n1"]["from_lane"] == "Lane A"
    assert moved["n1"]["to_lane"] == "Lane B"
    added = {c["name"] for c in d["nodes"]["added"]}
    assert "n2-new" in added


def test_diff_name_fallback_without_lineage(client, db):
    """Pre-SP-4 versions (no _lineage_id) fall back to name matching."""
    proj, model, version, lanes, nodes = _seed(db)  # no lineage stamped
    v2_id = client.post(_copy_url(proj, model, version), json={}).json()["id"]
    # v2 nodes get seeded lineage on copy; v1 nodes have none → identity keys
    # differ, but name fallback still matches v1's "n0" to v2's "n0".
    d = client.get(_diff_url(proj, model, version.id, v2_id)).json()
    # Same names on both sides, no edits → nothing added/removed.
    assert d["nodes"]["added"] == []
    assert d["nodes"]["removed"] == []


def test_diff_404_for_foreign_version(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    proj2, model2, version2, _, _ = _seed(db)
    r = client.get(_diff_url(proj, model, version.id, version2.id))
    assert r.status_code == 404, r.text
```

> Note on `test_diff_name_fallback_without_lineage`: v1 nodes have no `_lineage_id`, so their identity key is `name:n0`. v2's copied nodes were seeded with `_lineage_id = <v1 node id>`, so their key is `lin:<id>`. These differ — which would wrongly report add+remove. The fallback rule (below) fixes this: when a node has no lineage on one side, fall back to matching by name. The diff algorithm must therefore match in two passes (lineage first, then unmatched-by-name). Implement exactly that.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && pytest tests/test_version_control.py -k diff -v`
Expected: FAIL — diff route 404.

- [ ] **Step 3: Implement the diff endpoint**

Append to `backend/app/api/v2/versions.py`:

```python
def _graph(db: Session, version: ProcessVersion):
    lanes = db.scalars(
        select(ProcessLane).where(ProcessLane.version_id == version.id)
    ).all()
    nodes = db.scalars(
        select(ProcessNode).where(ProcessNode.version_id == version.id)
    ).all()
    edges = db.scalars(
        select(ProcessEdge).where(ProcessEdge.version_id == version.id)
    ).all()
    return lanes, nodes, edges


def _lineage(node: ProcessNode) -> str | None:
    return (node.properties or {}).get(LINEAGE_KEY)


def _match_nodes(a_nodes, b_nodes):
    """Pair A-side and B-side nodes. Match by lineage id first, then fall
    back to name for nodes that have no lineage on one side. Returns
    (pairs, only_a, only_b) where pairs is a list of (a_node, b_node)."""
    a_by_lin = {_lineage(n): n for n in a_nodes if _lineage(n)}
    b_by_lin = {_lineage(n): n for n in b_nodes if _lineage(n)}
    pairs = []
    matched_a, matched_b = set(), set()
    for lin, a in a_by_lin.items():
        b = b_by_lin.get(lin)
        if b is not None:
            pairs.append((a, b))
            matched_a.add(a.id); matched_b.add(b.id)
    # Name fallback for the leftovers.
    rem_a = [n for n in a_nodes if n.id not in matched_a]
    rem_b = [n for n in b_nodes if n.id not in matched_b]
    b_by_name: dict[str, ProcessNode] = {}
    for n in rem_b:
        b_by_name.setdefault(n.name, n)
    for a in rem_a:
        b = b_by_name.pop(a.name, None)
        if b is not None:
            pairs.append((a, b))
            matched_a.add(a.id); matched_b.add(b.id)
    only_a = [n for n in a_nodes if n.id not in matched_a]
    only_b = [n for n in b_nodes if n.id not in matched_b]
    return pairs, only_a, only_b


@router.get(
    # NOTE: `version-diff`, NOT `versions/diff` — the latter would be matched
    # by the existing GET `/process-maps/{model_id}/versions/{version_id}`
    # (registered earlier) with version_id="diff", which 422s before reaching
    # this handler.
    "/process-maps/{model_id}/version-diff",
    response_model=VersionDiffRead,
)
def diff_versions(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    from_: UUID = Query(alias="from"),
    to: UUID = Query(...),
) -> VersionDiffRead:
    model = _model_or_404(db, model_id, project.id)
    va = _version_or_404(db, model, from_)
    vb = _version_or_404(db, model, to)

    a_lanes, a_nodes, a_edges = _graph(db, va)
    b_lanes, b_nodes, b_edges = _graph(db, vb)

    a_lane_name = {l.id: l.name for l in a_lanes}
    b_lane_name = {l.id: l.name for l in b_lanes}

    pairs, only_a, only_b = _match_nodes(a_nodes, b_nodes)

    renamed, moved = [], []
    unchanged = 0
    for a, b in pairs:
        a_lane = a_lane_name.get(a.lane_id)
        b_lane = b_lane_name.get(b.lane_id)
        if a.name != b.name:
            renamed.append(NodeChange(name=b.name, from_name=a.name))
        elif a_lane != b_lane:
            moved.append(NodeChange(name=b.name, from_lane=a_lane, to_lane=b_lane))
        else:
            unchanged += 1

    node_diff = NodeDiff(
        added=[NodeChange(name=n.name) for n in only_b],
        removed=[NodeChange(name=n.name) for n in only_a],
        renamed=renamed,
        moved=moved,
        unchanged_count=unchanged,
    )

    # Edges: identity = (source_identity, target_identity) where node identity
    # is lineage if present else name. Resolve via the node objects per side.
    def _edge_keys(nodes, edges):
        ident = {}
        for n in nodes:
            ident[n.id] = _lineage(n) or f"name:{n.name}"
        names = {n.id: n.name for n in nodes}
        keys = {}
        for e in edges:
            keys[(ident[e.source_node_id], ident[e.target_node_id])] = (
                names[e.source_node_id],
                names[e.target_node_id],
            )
        return keys

    a_edge_keys = _edge_keys(a_nodes, a_edges)
    b_edge_keys = _edge_keys(b_nodes, b_edges)
    edge_diff = EdgeDiff(
        added=[EdgeChange(source=s, target=t) for k, (s, t) in b_edge_keys.items() if k not in a_edge_keys],
        removed=[EdgeChange(source=s, target=t) for k, (s, t) in a_edge_keys.items() if k not in b_edge_keys],
    )

    a_lane_names = {l.name for l in a_lanes}
    b_lane_names = {l.name for l in b_lanes}
    lane_diff = LaneDiff(
        added=[LaneChange(name=n) for n in b_lane_names - a_lane_names],
        removed=[LaneChange(name=n) for n in a_lane_names - b_lane_names],
    )

    return VersionDiffRead(nodes=node_diff, edges=edge_diff, lanes=lane_diff)
```

Add `Query` to the FastAPI import at the top of `versions.py`:

```python
from fastapi import APIRouter, Depends, HTTPException, Query
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && pytest tests/test_version_control.py -v`
Expected: PASS (all version-control tests).

- [ ] **Step 5: Run the full backend suite (no regressions)**

Run: `cd backend && pytest -q`
Expected: PASS (the SP-3 suite + everything else still green).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v2/versions.py backend/tests/test_version_control.py
git commit -m "$(cat <<'EOF'
feat(sp4): version diff endpoint (lineage match + name fallback)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Frontend — types + API client

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the types**

Append to `src/lib/types.ts` (after the `ProcessVersion` block, near the other version/review types):

```typescript
export interface VersionSummary {
  id: UUID;
  version_number: number;
  parent_version_id: UUID | null;
  status: string;
  notes: string | null;
  created_at: string;
  node_count: number;
  lane_count: number;
  edge_count: number;
}

export interface NodeChange {
  name: string;
  from_name?: string | null;
  from_lane?: string | null;
  to_lane?: string | null;
}

export interface EdgeChange {
  source: string;
  target: string;
}

export interface LaneChange {
  name: string;
}

export interface VersionDiff {
  nodes: {
    added: NodeChange[];
    removed: NodeChange[];
    renamed: NodeChange[];
    moved: NodeChange[];
    unchanged_count: number;
  };
  edges: { added: EdgeChange[]; removed: EdgeChange[] };
  lanes: { added: LaneChange[]; removed: LaneChange[] };
}
```

- [ ] **Step 2: Add the API client functions**

In `src/lib/api.ts`, add `VersionDiff` and `VersionSummary` to the type import block at the top, then add these three functions inside the `api` object (next to `getProcessGraph`):

```typescript
  listVersions: (projectId: UUID, modelId: UUID) =>
    request<VersionSummary[]>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions`
    ),
  copyVersion: (
    projectId: UUID,
    modelId: UUID,
    sourceVersionId: UUID,
    note: string | null
  ) =>
    request<ProcessVersion>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${sourceVersionId}/copy`,
      { method: "POST", json: { note } }
    ),
  getVersionDiff: (
    projectId: UUID,
    modelId: UUID,
    fromId: UUID,
    toId: UUID
  ) =>
    request<VersionDiff>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/version-diff?from=${fromId}&to=${toId}`
    ),
```

Ensure `ProcessVersion` is already imported in `api.ts` (it is used elsewhere — confirm it is in the type import list; add it if missing).

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors). This task has no unit test — it is thin wrappers verified by `tsc` and exercised by Tasks 6–7, matching the existing untested API-client convention.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "$(cat <<'EOF'
feat(sp4): version + diff types and API client functions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Frontend — `version-tree.ts` column-assignment helper (TDD)

**Files:**
- Create: `src/components/canvas/version-tree.ts`
- Test: `src/components/canvas/version-tree.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/version-tree.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { buildVersionRows } from "./version-tree";
import type { VersionSummary } from "@/lib/types";

function v(
  id: string,
  version_number: number,
  parent_version_id: string | null
): VersionSummary {
  return {
    id,
    version_number,
    parent_version_id,
    status: "draft",
    notes: null,
    created_at: "2026-05-29T00:00:00Z",
    node_count: 0,
    lane_count: 0,
    edge_count: 0,
  };
}

describe("buildVersionRows", () => {
  it("puts a linear chain in a single column", () => {
    const rows = buildVersionRows([
      v("a", 1, null),
      v("b", 2, "a"),
      v("c", 3, "b"),
    ]);
    expect(rows.map((r) => r.column)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.parentColumn)).toEqual([null, 0, 0]);
  });

  it("forks a parent's second child into a new column", () => {
    // a -> b (first child, col 0); a -> c (second child, col 1)
    const rows = buildVersionRows([
      v("a", 1, null),
      v("b", 2, "a"),
      v("c", 3, "a"),
    ]);
    const col = Object.fromEntries(rows.map((r) => [r.version.id, r.column]));
    expect(col.a).toBe(0);
    expect(col.b).toBe(0);
    expect(col.c).toBe(1);
    const pcol = Object.fromEntries(rows.map((r) => [r.version.id, r.parentColumn]));
    expect(pcol.c).toBe(0); // its parent (a) is in column 0
  });

  it("assigns each additional child its own column", () => {
    const rows = buildVersionRows([
      v("a", 1, null),
      v("b", 2, "a"),
      v("c", 3, "a"),
      v("d", 4, "a"),
    ]);
    const col = Object.fromEntries(rows.map((r) => [r.version.id, r.column]));
    expect([col.b, col.c, col.d]).toEqual([0, 1, 2]);
  });

  it("gives a second root its own column", () => {
    const rows = buildVersionRows([v("a", 1, null), v("b", 2, null)]);
    expect(rows.map((r) => r.column)).toEqual([0, 1]);
  });

  it("returns rows in version_number order regardless of input order", () => {
    const rows = buildVersionRows([v("c", 3, "b"), v("a", 1, null), v("b", 2, "a")]);
    expect(rows.map((r) => r.version.version_number)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- version-tree`
Expected: FAIL — cannot find module `./version-tree`.

- [ ] **Step 3: Implement the helper**

Create `src/components/canvas/version-tree.ts`:

```typescript
import type { VersionSummary } from "@/lib/types";

export interface TreeRow {
  version: VersionSummary;
  /** 0-based column for this version's dot in the commit-graph rail. */
  column: number;
  /** Column of this version's parent (for drawing the connector); null if root. */
  parentColumn: number | null;
}

/**
 * Assign each version a column for a compact commit-graph rail.
 *
 * Rule: a child reuses its parent's column iff it is the parent's FIRST child
 * (by ascending version_number); later children fork into a fresh column.
 * Roots (no parent, or a parent outside this set) take the next free column.
 * Columns are never recycled — a deep fork history simply uses more columns,
 * which is fine for the narrow side panel and keeps the algorithm simple.
 *
 * Rows are returned in ascending version_number order.
 */
export function buildVersionRows(versions: VersionSummary[]): TreeRow[] {
  const byNum = [...versions].sort(
    (a, b) => a.version_number - b.version_number
  );
  const columnOf = new Map<string, number>();
  const firstChildTaken = new Set<string>();
  let nextFreeColumn = 0;

  const rows: TreeRow[] = [];
  for (const version of byNum) {
    const parentId = version.parent_version_id;
    let column: number;
    let parentColumn: number | null = null;

    if (parentId && columnOf.has(parentId)) {
      parentColumn = columnOf.get(parentId)!;
      if (!firstChildTaken.has(parentId)) {
        firstChildTaken.add(parentId);
        column = parentColumn;
      } else {
        column = nextFreeColumn++;
      }
    } else {
      column = nextFreeColumn++;
    }

    columnOf.set(version.id, column);
    rows.push({ version, column, parentColumn });
  }
  return rows;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- version-tree`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/version-tree.ts src/components/canvas/version-tree.test.ts
git commit -m "$(cat <<'EOF'
feat(sp4): version-tree column-assignment helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Frontend — `version-diff.ts` summary helper (TDD)

**Files:**
- Create: `src/components/canvas/version-diff.ts`
- Test: `src/components/canvas/version-diff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/version-diff.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { diffChangeCount, isEmptyDiff } from "./version-diff";
import type { VersionDiff } from "@/lib/types";

const empty: VersionDiff = {
  nodes: { added: [], removed: [], renamed: [], moved: [], unchanged_count: 7 },
  edges: { added: [], removed: [] },
  lanes: { added: [], removed: [] },
};

const some: VersionDiff = {
  nodes: {
    added: [{ name: "x" }],
    removed: [],
    renamed: [{ name: "b", from_name: "a" }],
    moved: [{ name: "c", from_lane: "L1", to_lane: "L2" }],
    unchanged_count: 3,
  },
  edges: { added: [{ source: "x", target: "y" }], removed: [] },
  lanes: { added: [], removed: [{ name: "Old" }] },
};

describe("diffChangeCount", () => {
  it("counts every change kind, ignoring unchanged_count", () => {
    expect(diffChangeCount(some)).toBe(5); // 1 added + 1 renamed + 1 moved + 1 edge added + 1 lane removed
  });
  it("is zero for an all-unchanged diff", () => {
    expect(diffChangeCount(empty)).toBe(0);
  });
});

describe("isEmptyDiff", () => {
  it("true when nothing changed", () => {
    expect(isEmptyDiff(empty)).toBe(true);
  });
  it("false when there are changes", () => {
    expect(isEmptyDiff(some)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- version-diff`
Expected: FAIL — cannot find module `./version-diff`.

- [ ] **Step 3: Implement the helper**

Create `src/components/canvas/version-diff.ts`:

```typescript
import type { VersionDiff } from "@/lib/types";

/** Total number of changes across nodes, edges, and lanes. Excludes
 *  unchanged nodes — this is the "how much moved" number for a badge. */
export function diffChangeCount(d: VersionDiff): number {
  return (
    d.nodes.added.length +
    d.nodes.removed.length +
    d.nodes.renamed.length +
    d.nodes.moved.length +
    d.edges.added.length +
    d.edges.removed.length +
    d.lanes.added.length +
    d.lanes.removed.length
  );
}

export function isEmptyDiff(d: VersionDiff): boolean {
  return diffChangeCount(d) === 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- version-diff`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/version-diff.ts src/components/canvas/version-diff.test.ts
git commit -m "$(cat <<'EOF'
feat(sp4): version-diff summary helper (change count / empty check)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Frontend — `VersionsTab` rewrite (tree + branch/restore + inline diff)

**Files:**
- Modify: `src/components/canvas/right-panel.tsx`
- Test: manual (the testable cores are covered by Tasks 5–6); verified by `tsc` + `build` + `./run-local.sh` smoke.

This task rewrites `VersionsTab` and threads a navigation callback through `RightPanel`. The page provides `onNavigateVersion` in Task 8.

> **Why the prop is optional:** `page.tsx` does not pass `onNavigateVersion` until Task 8. If the prop were required, the `tsc` check at the end of *this* task would fail (the page would be missing a required prop). Declaring it optional and guarding the call sites keeps every checkpoint green; branch/restore/open simply no-op until Task 8 wires the handler — fine, because navigation is manually smoke-tested in Task 9.

- [ ] **Step 1: Thread `onNavigateVersion` through `RightPanel`**

In `src/components/canvas/right-panel.tsx`:

1. Add the prop to the `RightPanel` destructured params and its type (after `onSendRequest`):

```typescript
  onSendRequest,
  onNavigateVersion,
  collapsed,
```

```typescript
  onSendRequest: () => void;
  onNavigateVersion?: (versionId: UUID) => void;
  collapsed: boolean;
```

2. Pass the data `RightPanel` already has into `VersionsTab` (replace the existing `{tab === "versions" && <VersionsTab version={version} />}` line):

```tsx
        {tab === "versions" && (
          <VersionsTab
            projectId={projectId}
            modelId={modelId}
            versionId={versionId}
            onNavigateVersion={onNavigateVersion}
          />
        )}
```

- [ ] **Step 2: Add imports `VersionsTab` needs**

At the top of `right-panel.tsx`, ensure these are imported:

- From `@tanstack/react-query`: the file already imports `useMutation, useQuery` — add `useQueryClient` to that same line.
- From `react`: `ReactNode` is **already** imported as `type ReactNode` (used below by `RowButton` — no `React.*` needed).
- From `lucide-react`: `GitBranch` is already present; add `RotateCcw`, `GitCompare`, `Eye` to that import block.
- From `@/lib/types`: add `VersionSummary`, `VersionDiff` to the existing `import type { ... }` block.
- New local imports:

```typescript
import { buildVersionRows, type TreeRow } from "./version-tree";
import { diffChangeCount, isEmptyDiff } from "./version-diff";
```

- [ ] **Step 3: Replace the `VersionsTab` implementation**

Replace the entire existing `VersionsTab` function (lines ~428–486) with:

```tsx
// ─── Versions tab ───────────────────────────────────────────
const COL_WIDTH = 16; // px per commit-graph column
const ROW_DOT_R = 4;

function VersionsTab({
  projectId,
  modelId,
  versionId,
  onNavigateVersion,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  onNavigateVersion?: (versionId: UUID) => void;
}) {
  const queryClient = useQueryClient();
  const [diffFrom, setDiffFrom] = useState<UUID | null>(null);

  const versionsQuery = useQuery({
    queryKey: ["versions", projectId, modelId],
    queryFn: () => api.listVersions(projectId, modelId),
  });
  const versions = versionsQuery.data ?? [];
  const rows = buildVersionRows(versions);
  const latestNumber = versions.reduce(
    (max, v) => Math.max(max, v.version_number),
    0
  );
  const columnCount = rows.reduce((m, r) => Math.max(m, r.column + 1), 1);

  const copyMutation = useMutation({
    mutationFn: (vars: { sourceId: UUID; note: string }) =>
      api.copyVersion(projectId, modelId, vars.sourceId, vars.note),
    onSuccess: (newVersion) => {
      queryClient.invalidateQueries({ queryKey: ["versions", projectId, modelId] });
      onNavigateVersion?.(newVersion.id);
    },
  });

  const branchFromCurrent = () => {
    const current = versions.find((v) => v.id === versionId);
    copyMutation.mutate({
      sourceId: versionId,
      note: current ? `Branched from v${current.version_number}` : "Branch",
    });
  };

  if (versionsQuery.isLoading) {
    return <div className="px-3 py-3 text-[11px] text-slate-400">Loading versions…</div>;
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Version History
        </div>
        <button
          onClick={branchFromCurrent}
          disabled={copyMutation.isPending}
          title="Branch from the current version"
          className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-[10px] font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          <GitBranch size={11} />
          Branch
        </button>
      </div>

      <div className="space-y-1.5">
        {rows
          .slice()
          .reverse() // newest at top
          .map((row) => (
            <VersionRow
              key={row.version.id}
              row={row}
              columnCount={columnCount}
              isCurrent={row.version.id === versionId}
              isLatest={row.version.version_number === latestNumber}
              busy={copyMutation.isPending}
              onOpen={() => onNavigateVersion?.(row.version.id)}
              onCopy={(note) =>
                copyMutation.mutate({ sourceId: row.version.id, note })
              }
              onDiff={() => setDiffFrom(row.version.id)}
            />
          ))}
      </div>

      {diffFrom && (
        <DiffPanel
          projectId={projectId}
          modelId={modelId}
          fromId={diffFrom}
          toId={versionId}
          fromLabel={
            versions.find((v) => v.id === diffFrom)?.version_number ?? "?"
          }
          toLabel={
            versions.find((v) => v.id === versionId)?.version_number ?? "?"
          }
          onClose={() => setDiffFrom(null)}
        />
      )}
    </div>
  );
}

function VersionRow({
  row,
  columnCount,
  isCurrent,
  isLatest,
  busy,
  onOpen,
  onCopy,
  onDiff,
}: {
  row: TreeRow;
  columnCount: number;
  isCurrent: boolean;
  isLatest: boolean;
  busy: boolean;
  onOpen: () => void;
  onCopy: (note: string) => void;
  onDiff: () => void;
}) {
  const v = row.version;
  const railWidth = columnCount * COL_WIDTH;
  return (
    <div
      className={`flex gap-2 rounded-md border px-2 py-1.5 ${
        isCurrent ? "border-slate-800 bg-slate-50" : "border-slate-200 bg-white"
      }`}
    >
      {/* Commit-graph rail */}
      <svg width={railWidth} height={44} className="flex-shrink-0">
        {row.parentColumn !== null && (
          <line
            x1={row.column * COL_WIDTH + COL_WIDTH / 2}
            y1={ROW_DOT_R + 2}
            x2={row.parentColumn * COL_WIDTH + COL_WIDTH / 2}
            y2={44}
            stroke="#cbd5e1"
            strokeWidth={1.5}
          />
        )}
        <circle
          cx={row.column * COL_WIDTH + COL_WIDTH / 2}
          cy={ROW_DOT_R + 6}
          r={ROW_DOT_R}
          fill={isCurrent ? "#1e293b" : "#94a3b8"}
        />
      </svg>

      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-slate-400">
            v{v.version_number}
          </span>
          {isLatest && (
            <span className="rounded bg-emerald-100 px-1 py-px text-[9px] font-bold text-emerald-700">
              latest
            </span>
          )}
          <span className="rounded bg-slate-200 px-1 py-px text-[9px] font-bold text-slate-700">
            {v.status}
          </span>
          <span className="text-[9px] text-slate-400">{v.node_count} nodes</span>
        </div>
        <div className="truncate text-[11px] leading-snug text-slate-800">
          {v.notes ?? "—"}
        </div>
        <div className="mt-0.5 text-[10px] text-slate-400">
          {new Date(v.created_at).toLocaleString()}
        </div>

        {/* Row actions */}
        <div className="mt-1 flex flex-wrap gap-1">
          {!isCurrent && (
            <RowButton icon={<Eye size={10} />} label="Open" onClick={onOpen} disabled={busy} />
          )}
          {isCurrent ? (
            <RowButton
              icon={<GitBranch size={10} />}
              label="Branch"
              onClick={() => onCopy(`Branched from v${v.version_number}`)}
              disabled={busy}
            />
          ) : (
            <RowButton
              icon={<RotateCcw size={10} />}
              label="Restore"
              onClick={() => onCopy(`Restored from v${v.version_number}`)}
              disabled={busy}
            />
          )}
          {!isCurrent && (
            <RowButton
              icon={<GitCompare size={10} />}
              label="Diff vs current"
              onClick={onDiff}
              disabled={busy}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function RowButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );
}

function DiffPanel({
  projectId,
  modelId,
  fromId,
  toId,
  fromLabel,
  toLabel,
  onClose,
}: {
  projectId: UUID;
  modelId: UUID;
  fromId: UUID;
  toId: UUID;
  fromLabel: number | string;
  toLabel: number | string;
  onClose: () => void;
}) {
  const diffQuery = useQuery({
    queryKey: ["version-diff", projectId, modelId, fromId, toId],
    queryFn: () => api.getVersionDiff(projectId, modelId, fromId, toId),
  });
  const d = diffQuery.data;

  return (
    <div className="mt-4 rounded-md border border-slate-300 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          v{fromLabel} → v{toLabel}
        </div>
        <button
          onClick={onClose}
          className="text-[10px] font-semibold text-slate-500 hover:text-slate-800"
        >
          Close
        </button>
      </div>
      {diffQuery.isLoading && (
        <div className="text-[11px] text-slate-400">Computing diff…</div>
      )}
      {d && isEmptyDiff(d) && (
        <div className="text-[11px] italic text-slate-500">No structural changes.</div>
      )}
      {d && !isEmptyDiff(d) && (
        <div className="space-y-1.5 text-[11px]">
          <DiffGroup color="text-emerald-700" label="Added" items={d.nodes.added.map((n) => n.name)} />
          <DiffGroup color="text-rose-700" label="Removed" items={d.nodes.removed.map((n) => n.name)} />
          <DiffGroup
            color="text-amber-700"
            label="Renamed"
            items={d.nodes.renamed.map((n) => `${n.from_name} → ${n.name}`)}
          />
          <DiffGroup
            color="text-sky-700"
            label="Moved"
            items={d.nodes.moved.map((n) => `${n.name}: ${n.from_lane} → ${n.to_lane}`)}
          />
          <div className="pt-1 text-[10px] text-slate-400">
            edges +{d.edges.added.length}/−{d.edges.removed.length} ·
            lanes +{d.lanes.added.length}/−{d.lanes.removed.length} ·
            {d.nodes.unchanged_count} unchanged · {diffChangeCount(d)} changes
          </div>
        </div>
      )}
    </div>
  );
}

function DiffGroup({
  color,
  label,
  items,
}: {
  color: string;
  label: string;
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <span className={`font-semibold ${color}`}>
        {label} ({items.length})
      </span>
      <ul className="ml-3 list-disc text-slate-700">
        {items.map((it, i) => (
          <li key={i} className="truncate">
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS. (`ReactNode` is already imported at the top of the file; `onNavigateVersion` is optional, so `page.tsx` not passing it yet is not an error.)

- [ ] **Step 5: Run the frontend test + build**

Run: `npm test` then `npm run build`
Expected: both PASS (existing tests still green; new build clean).

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/right-panel.tsx
git commit -m "$(cat <<'EOF'
feat(sp4): VersionsTab — commit-graph tree, branch/restore, inline diff

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Frontend — page wiring (navigation + invalidation)

**Files:**
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx`

- [ ] **Step 1: Import `useRouter`**

Change line 5 to import both hooks:

```typescript
import { useParams, useRouter } from "next/navigation";
```

- [ ] **Step 2: Create the router + navigation handler**

Inside `CanvasPage`, after `const queryClient = useQueryClient();` (line 66), add:

```typescript
  const router = useRouter();

  const handleNavigateVersion = useCallback(
    (newVersionId: UUID) => {
      router.push(
        `/projects/${params.id}/maps/${params.modelId}/versions/${newVersionId}`
      );
    },
    [router, params.id, params.modelId]
  );
```

- [ ] **Step 3: Pass `onNavigateVersion` to `RightPanel`**

In the `<RightPanel ... />` JSX (around line 383–406), add the prop next to `onSendRequest`:

```tsx
            reviewState={reviewState}
            onSendRequest={() => requestReviewMutation.mutate()}
            onNavigateVersion={handleNavigateVersion}
            collapsed={rightCollapsed}
```

- [ ] **Step 4: Verify compile + build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "$(cat <<'EOF'
feat(sp4): wire version navigation from the Versions tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Full verification + manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Backend suite**

Run: `cd backend && pytest -q`
Expected: PASS (SP-3 + SP-4 + everything else).

- [ ] **Step 2: Frontend gates**

Run from repo root:
```bash
npx tsc --noEmit
npm test
npm run build
```
Expected: all PASS. (Lint is advisory — see [[frontend-lint-baseline]] — not a gate.)

- [ ] **Step 3: Manual smoke against the running app**

Start the stack: `./run-local.sh start` (then `./run-local.sh status` to confirm). Open an existing map at `/projects/{id}/maps/{modelId}/versions/{versionId}` and exercise the Versions tab:

1. **Branch** — click the toolbar **Branch**. Expect: a new `vN+1` row appears as `latest`, you navigate to it, the canvas still renders the same graph, and the top bar shows the new version number with `draft` status.
2. **Edit** — rename a node / move it to another lane / delete an edge on the new version (live PATCH).
3. **Restore** — in the Versions tab, click **Restore** on an older version. Expect: a new latest version is created (parented on the old one), you navigate to it, and its graph matches the old version.
4. **Diff** — on a non-current row, click **Diff vs current**. Expect: the inline panel shows added/removed/renamed/moved consistent with the edits from step 2 (a rename shows under "Renamed", a lane move under "Moved").
5. **Tree** — confirm the rail shows a fork column when you branched twice from the same version.
6. **Provenance** — open a node that had citations on the source version (Issues/citations) and confirm claim links survived the copy.

If anything fails, fix it under the relevant task before completing.

- [ ] **Step 4: Append the execution outcome to this plan**

Add an "## Execution outcome" section recording: commit range, test counts (backend pytest / Vitest), build status, and the manual smoke result. Note any deferred follow-ups discovered.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-29-sp4-version-control.md
git commit -m "$(cat <<'EOF'
docs(sp4): record version-control execution outcome

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the implementer

- **No migration.** Lineage lives in `ProcessNode.properties["_lineage_id"]`. Do not add an Alembic migration. (If a future change does add one, the dev `poet` DB must be `alembic upgrade head`'d or the hot-reloading backend 500s — see [[dev-db-migration-on-reload]].)
- **Stacked branch.** This work is on `sp4-version-control` (off `sp3-stakeholder-review`). Commit locally only; do not push. Do not use `rm`/`git rm`.
- **Mutations are not on the canvas undo stack.** Branch/restore navigate away; they are react-query mutations that invalidate `["versions", projectId, modelId]`, exactly like SP-3's review mutations invalidate `["review", ...]`.
- **The route param change does the heavy lifting.** Navigating to the new version's URL re-keys the `["graph"]`/`["issues"]`/`["review"]` queries, so the canvas re-renders the new version with no extra code.
- **Diff is structural, not visual.** It is a list of changes, not a canvas overlay. A visual side-by-side is explicitly out of scope (see the spec).

---

## Execution outcome

_Executed 2026-05-29 via `superpowers:subagent-driven-development` (fresh implementer + spec review + code-quality review per task), on branch `sp4-version-control` (stacked on `sp3-stakeholder-review`)._

**Result: complete.** All 9 tasks landed. Commit range `c93c46c … a666646` (16 commits).

**Gates (final):**
- Backend: `pytest -q` → **76 passed** (14 in `test_version_control.py`, no regressions).
- Frontend: `tsc --noEmit` clean; `npm test` → **30 passed** (incl. version-tree 6, version-diff 4); `npm run build` clean (the `…/versions/[versionId]` route compiles).
- Lint advisory only (pre-existing react-compiler errors unchanged).

**Live API smoke (against `./run-local.sh`, real Postgres dev DB):** PASS, then dev DB restored to its original state (the two smoke versions deleted; cascade removed their 20 nodes / 18 edges / 2 lanes; model left with only v1).
- `GET versions` → v1 with correct counts (10 nodes / 1 lane / 9 edges).
- `POST copy` (branch) → v2 created, `parent_version_id` = v1, status draft, `bpmn_xml` + notes copied, `parent_version_id` present in the response.
- `POST copy` again (restore-from-v1) → v3 parented on v1 (a real fork: v1 has two children).
- `GET version-diff` v1→v2 → after the fix below, a fully empty diff (10 unchanged nodes, 0 edge/lane changes).

**Bug caught by the live smoke (and missed by unit tests):** the diff reported **every edge as both added and removed** when diffing a *pre-SP-4 generated* version (nodes lack `_lineage_id`) against a *copy* of it (nodes seeded with lineage). `_match_nodes` reconciled the nodes via its name-fallback, but `_edge_keys` computed each side's endpoint identity independently (`_lineage(n) or name:…`), so the two sides never agreed. The unit tests missed it because they stamped lineage on both sides (or neither). **Fixed in `a666646`:** edge identity now reuses the `_match_nodes` pairing — matched node pairs share one canonical key, so edges compare consistently regardless of whether nodes matched by lineage or by name. Regression test `test_diff_identical_copy_of_unstamped_version_has_no_changes` reproduces the exact scenario (fails-before / passes-after). This is the strongest argument for keeping the live smoke in the loop — the heuristic-matching gap was invisible to the in-suite fixtures.

**Per-task review notes (issues found + fixed before each task closed):**
- T1: spec review caught the dropped `LINEAGE_KEY` constant (restored); added list-endpoint 404 test + schema docstring.
- T2: code review → exposed `parent_version_id` on `ProcessVersionRead` (+ frontend type), shared `LINEAGE_KEY` via new `app/constants.py`, added an explicit edge-remap assertion.
- T3: code review → promoted `_edge_keys` to module level, added `removed`/edge/lane diff tests. (The deeper edge-identity bug above survived this review and was only caught live.)
- T7: spec review removed two dead type imports; code review → clear diff panel on copy, dropped the duplicate per-row Branch on the current row, added empty/error states + `type="button"`.

**Deferred follow-ups (out of scope, intentionally):**
- Merge / 3-way conflict resolution.
- A *visual* canvas diff (this ships a structured list diff).
- A graphical-tree polish beyond the compact column rail; column recycling for very deep fork histories.
- Parallel edges between the same node pair collapse to one diff entry (documented in code).
- A node that is both renamed *and* moved is reported under "renamed" only (the lane change isn't surfaced in that bucket) — documented in code.
- Surfacing AI/`ai_proposed` provenance distinctly is SP-5, not here.
