# SP-3 — Stakeholder Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Wire the dormant `Review` model into per-node Approve/Request-change, a real Review-tab sign-off meter + buckets + send-request, and a review-mode per-node badge overlay — with `ProcessVersion.status` auto-transitioning draft→review→approved.

**Architecture:** No migration (the `reviews`/`review_comments` tables already exist). 3 new endpoints behind one page-level "review state" react-query; review actions are mutations that invalidate it (not on the canvas undo stack). Per-node `Review` rows (`target_type="process_node"`, upsert, pending = no row) + one version-level `Review`. Mirrors the existing `issuesByNode` overlay plumbing.

**Tech Stack:** FastAPI + SQLAlchemy + pytest (Postgres :5433, `poet_test`); Next.js 16 + React 19 + TS + Vitest. Binding gates: `npx tsc --noEmit`, `npm test`, `npm run build`, backend `pytest`, manual via `./run-local.sh`. Lint advisory.

**Reference spec:** `docs/superpowers/specs/2026-05-29-sp3-stakeholder-review-design.md`

**Commit discipline:** commit locally after each task; do NOT push. End each message with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

**Key facts (verified):**
- `Review` (`backend/app/models/workflow.py`): `project_id`, `target_type` (str), `target_id` (UUID, not FK), `requested_by`, `assigned_to`, `status`, `notes`.
- Enums (`backend/app/enums.py`): `ReviewStatus` {requested,in_progress,approved,changes_requested}; `ReviewTargetType` {process_model,process_version,process_node,process_edge}; `ProcessVersionStatus` {draft,review,approved}.
- Route conventions (`backend/app/api/v2/process_maps.py`): `Depends(get_project_or_404)`, `Depends(get_db)`, `Depends(get_current_user)`; graph route validates `model.project_id==project.id` then `version.model_id==model.id`; router prefix `/projects/{project_id}`.
- Frontend overlay pattern: `BpmnCanvas` prop `issuesByNode?: Record<string, IssueSeverity>` (line ~163) → `issuesMap` (207) → `<NodeShape issueLevel={showIssues ? issuesMap[node.id] ?? null : null}>` (1771); `NodeShape` renders a corner badge at `translate(w-8,-8)` when `issueLevel` (shapes.tsx 293).
- `api.ts` uses `request<T>(path, { method, json })`; methods grouped on the exported `api` object.

---

## Task 1: Backend — review schemas + router + GET review-state + register + tests

**Files:**
- Create: `backend/app/schemas/review.py`
- Create: `backend/app/api/v2/reviews.py`
- Modify: `backend/app/api/v2/__init__.py`
- Create: `backend/tests/test_stakeholder_review.py`

- [ ] **Step 1: Create the schemas** — `backend/app/schemas/review.py`:
```python
from uuid import UUID

from pydantic import BaseModel, Field


class NodeReviewUpdate(BaseModel):
    status: str = Field(pattern=r"^(approved|changes_requested)$")
    note: str | None = Field(default=None, max_length=2000)


class NodeReviewRead(BaseModel):
    node_id: UUID
    status: str
    note: str | None = None


class ReviewCounts(BaseModel):
    approved: int
    changes_requested: int
    pending: int
    total: int


class ReviewStateRead(BaseModel):
    version_id: UUID
    version_status: str
    request_status: str | None = None
    nodes: list[NodeReviewRead]
    counts: ReviewCounts
```

- [ ] **Step 2: Create the router with the state builder + GET** — `backend/app/api/v2/reviews.py`:
```python
"""SP-3: stakeholder review endpoints. Reuses the Review model — per-node
decisions (target_type=process_node) plus one version-level request row."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_current_user, get_project_or_404
from app.db.session import get_db
from app.enums import ProcessVersionStatus, ReviewStatus, ReviewTargetType
from app.models.identity import User
from app.models.process import ProcessModel, ProcessNode, ProcessVersion
from app.models.project import Project
from app.models.workflow import Review
from app.schemas.review import (
    NodeReviewRead,
    NodeReviewUpdate,
    ReviewCounts,
    ReviewStateRead,
)

router = APIRouter(prefix="/projects/{project_id}", tags=["reviews"])


def _version_or_404(db: Session, model_id: UUID, version_id: UUID, project_id: UUID) -> ProcessVersion:
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project_id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    return version


def _node_or_404(db: Session, node_id: UUID, project_id: UUID) -> ProcessNode:
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    version = db.get(ProcessVersion, node.version_id)
    model = db.get(ProcessModel, version.model_id) if version else None
    if model is None or model.project_id != project_id:
        raise HTTPException(status_code=404, detail="Node not found")
    return node


def _node_review(db: Session, node_id: UUID) -> Review | None:
    return db.scalars(
        select(Review).where(
            Review.target_type == ReviewTargetType.PROCESS_NODE.value,
            Review.target_id == node_id,
        )
    ).first()


def _version_review(db: Session, version_id: UUID) -> Review | None:
    return db.scalars(
        select(Review).where(
            Review.target_type == ReviewTargetType.PROCESS_VERSION.value,
            Review.target_id == version_id,
        )
    ).first()


def _build_review_state(db: Session, version: ProcessVersion) -> ReviewStateRead:
    node_ids = list(
        db.scalars(select(ProcessNode.id).where(ProcessNode.version_id == version.id)).all()
    )
    total = len(node_ids)
    nodes: list[NodeReviewRead] = []
    approved = changes = 0
    if node_ids:
        rows = db.scalars(
            select(Review).where(
                Review.target_type == ReviewTargetType.PROCESS_NODE.value,
                Review.target_id.in_(node_ids),
            )
        ).all()
        for r in rows:
            nodes.append(NodeReviewRead(node_id=r.target_id, status=r.status, note=r.notes))
            if r.status == ReviewStatus.APPROVED.value:
                approved += 1
            elif r.status == ReviewStatus.CHANGES_REQUESTED.value:
                changes += 1
    vr = _version_review(db, version.id)
    return ReviewStateRead(
        version_id=version.id,
        version_status=version.status,
        request_status=vr.status if vr else None,
        nodes=nodes,
        counts=ReviewCounts(
            approved=approved,
            changes_requested=changes,
            pending=total - approved - changes,
            total=total,
        ),
    )


def _recompute_version_status(db: Session, version: ProcessVersion) -> None:
    node_ids = list(
        db.scalars(select(ProcessNode.id).where(ProcessNode.version_id == version.id)).all()
    )
    total = len(node_ids)
    approved = 0
    if node_ids:
        approved = db.scalar(
            select(func.count())
            .select_from(Review)
            .where(
                Review.target_type == ReviewTargetType.PROCESS_NODE.value,
                Review.target_id.in_(node_ids),
                Review.status == ReviewStatus.APPROVED.value,
            )
        ) or 0
    vr = _version_review(db, version.id)
    if total > 0 and approved == total:
        version.status = ProcessVersionStatus.APPROVED.value
        if vr is not None:
            vr.status = ReviewStatus.APPROVED.value
    elif vr is not None:
        version.status = ProcessVersionStatus.REVIEW.value
        vr.status = ReviewStatus.REQUESTED.value


@router.get(
    "/process-maps/{model_id}/versions/{version_id}/review",
    response_model=ReviewStateRead,
)
def get_review_state(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> ReviewStateRead:
    version = _version_or_404(db, model_id, version_id, project.id)
    return _build_review_state(db, version)
```

- [ ] **Step 3: Register the router** — in `backend/app/api/v2/__init__.py`, add (next to the other `router.include_router(...)` lines):
```python
from app.api.v2 import reviews  # add to the existing imports
router.include_router(reviews.router)
```
(Match the existing import + include style in that file.)

- [ ] **Step 4: Write the test file** — `backend/tests/test_stakeholder_review.py`. Seed helper makes a 2-node version (so "all approved" needs two actions). Model on `test_node_lane_editing.py`.
```python
"""Integration tests for SP-3 stakeholder review."""
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.enums import ProcessVersionStatus, ReviewStatus, ReviewTargetType
from app.models.identity import Organization, User
from app.models.process import ProcessModel, ProcessNode, ProcessVersion
from app.models.project import Project
from app.models.workflow import Review


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed(db, n_nodes=2):
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    model = ProcessModel(project_id=proj.id, name="m", level="L1"); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft"); db.add(version); db.flush()
    nodes = []
    for i in range(n_nodes):
        nd = ProcessNode(version_id=version.id, lane_id=None, type="task", name=f"n{i}", position={}, properties={})
        db.add(nd); nodes.append(nd)
    db.flush(); db.commit()
    return proj, model, version, nodes


def _state_url(proj, model, version):
    return f"/api/v2/projects/{proj.id}/process-maps/{model.id}/versions/{version.id}/review"


def test_get_review_state_defaults_pending(client, db):
    proj, model, version, nodes = _seed(db)
    resp = client.get(_state_url(proj, model, version))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version_status"] == "draft"
    assert body["request_status"] is None
    assert body["nodes"] == []
    assert body["counts"] == {"approved": 0, "changes_requested": 0, "pending": 2, "total": 2}
```

- [ ] **Step 5: Run the test, verify it passes** (after implementing Steps 1-3):
`cd backend && .venv/bin/pytest tests/test_stakeholder_review.py -q`
Expected: 1 passed. (If the `poet_test` DB predates the reviews table, the conftest's `alembic upgrade head` already created it — reviews came in the initial schema migration, so no action needed.)

- [ ] **Step 6: Commit**
```bash
git add backend/app/schemas/review.py backend/app/api/v2/reviews.py backend/app/api/v2/__init__.py backend/tests/test_stakeholder_review.py
git commit -m "feat(sp3): review schemas + router + GET review-state endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend — PATCH node review + POST request (lifecycle) + tests

**Files:**
- Modify: `backend/app/api/v2/reviews.py` (add 2 endpoints; `_recompute_version_status` already added in Task 1)
- Modify: `backend/tests/test_stakeholder_review.py` (append tests)

- [ ] **Step 1: Append the failing tests** to `backend/tests/test_stakeholder_review.py`:
```python
def test_patch_node_review_approves_and_counts(client, db):
    proj, model, version, nodes = _seed(db)
    r = client.patch(
        f"/api/v2/projects/{proj.id}/nodes/{nodes[0].id}/review",
        json={"status": "approved"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
    body = client.get(_state_url(proj, model, version)).json()
    assert body["counts"]["approved"] == 1
    assert body["counts"]["pending"] == 1


def test_change_request_with_note(client, db):
    proj, model, version, nodes = _seed(db)
    r = client.patch(
        f"/api/v2/projects/{proj.id}/nodes/{nodes[0].id}/review",
        json={"status": "changes_requested", "note": "fix the label"},
    )
    assert r.status_code == 200, r.text
    nstate = [n for n in client.get(_state_url(proj, model, version)).json()["nodes"] if n["node_id"] == str(nodes[0].id)][0]
    assert nstate["status"] == "changes_requested"
    assert nstate["note"] == "fix the label"


def test_invalid_status_rejected(client, db):
    proj, model, version, nodes = _seed(db)
    r = client.patch(f"/api/v2/projects/{proj.id}/nodes/{nodes[0].id}/review", json={"status": "bogus"})
    assert r.status_code == 422, r.text


def test_request_flips_version_to_review(client, db):
    proj, model, version, nodes = _seed(db)
    r = client.post(f"{_state_url(proj, model, version)}/request")
    assert r.status_code == 200, r.text
    assert r.json()["version_status"] == "review"
    assert r.json()["request_status"] == "requested"
    db.expire_all()
    assert db.get(ProcessVersion, version.id).status == "review"


def test_all_approved_flips_version_to_approved(client, db):
    proj, model, version, nodes = _seed(db)
    client.post(f"{_state_url(proj, model, version)}/request")
    for nd in nodes:
        client.patch(f"/api/v2/projects/{proj.id}/nodes/{nd.id}/review", json={"status": "approved"})
    body = client.get(_state_url(proj, model, version)).json()
    assert body["counts"]["approved"] == 2
    assert body["version_status"] == "approved"
    assert body["request_status"] == "approved"


def test_change_request_keeps_version_in_review(client, db):
    proj, model, version, nodes = _seed(db)
    client.post(f"{_state_url(proj, model, version)}/request")
    client.patch(f"/api/v2/projects/{proj.id}/nodes/{nodes[0].id}/review", json={"status": "approved"})
    client.patch(f"/api/v2/projects/{proj.id}/nodes/{nodes[1].id}/review", json={"status": "changes_requested"})
    body = client.get(_state_url(proj, model, version)).json()
    assert body["version_status"] == "review"
```

- [ ] **Step 2: Run, verify the new tests FAIL** (endpoints don't exist): `cd backend && .venv/bin/pytest tests/test_stakeholder_review.py -q`

- [ ] **Step 3: Add the two endpoints** to `backend/app/api/v2/reviews.py` (after `get_review_state`):
```python
@router.patch("/nodes/{node_id}/review", response_model=NodeReviewRead)
def set_node_review(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    payload: NodeReviewUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> NodeReviewRead:
    node = _node_or_404(db, node_id, project.id)
    review = _node_review(db, node_id)
    if review is None:
        review = Review(
            project_id=project.id,
            target_type=ReviewTargetType.PROCESS_NODE.value,
            target_id=node_id,
            requested_by=user.id,
            status=payload.status,
            notes=payload.note,
        )
        db.add(review)
    else:
        review.status = payload.status
        review.notes = payload.note
    db.flush()
    version = db.get(ProcessVersion, node.version_id)
    _recompute_version_status(db, version)
    db.commit()
    return NodeReviewRead(node_id=node_id, status=review.status, note=review.notes)


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/review/request",
    response_model=ReviewStateRead,
)
def request_review(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> ReviewStateRead:
    version = _version_or_404(db, model_id, version_id, project.id)
    vr = _version_review(db, version.id)
    if vr is None:
        vr = Review(
            project_id=project.id,
            target_type=ReviewTargetType.PROCESS_VERSION.value,
            target_id=version.id,
            requested_by=user.id,
            status=ReviewStatus.REQUESTED.value,
        )
        db.add(vr)
    else:
        vr.status = ReviewStatus.REQUESTED.value
    version.status = ProcessVersionStatus.REVIEW.value
    db.commit()
    db.refresh(version)
    return _build_review_state(db, version)
```

- [ ] **Step 4: Run, verify all pass:** `cd backend && .venv/bin/pytest tests/test_stakeholder_review.py -q` → 7 passed.

- [ ] **Step 5: Commit**
```bash
git add backend/app/api/v2/reviews.py backend/tests/test_stakeholder_review.py
git commit -m "feat(sp3): per-node review + version request with status auto-transition

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Backend — node-delete orphan cleanup + test

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (`delete_node`, ~line 658-671)
- Modify: `backend/tests/test_stakeholder_review.py`

- [ ] **Step 1: Append the failing test:**
```python
def test_deleted_node_review_is_removed(client, db):
    proj, model, version, nodes = _seed(db)
    client.patch(f"/api/v2/projects/{proj.id}/nodes/{nodes[0].id}/review", json={"status": "approved"})
    # delete the approved node
    d = client.delete(f"/api/v2/projects/{proj.id}/nodes/{nodes[0].id}")
    assert d.status_code == 204, d.text
    body = client.get(_state_url(proj, model, version)).json()
    assert body["counts"]["total"] == 1
    assert body["counts"]["approved"] == 0
    assert body["nodes"] == []
    # the orphan Review row is gone
    from app.models.workflow import Review as _R
    from app.enums import ReviewTargetType as _RT
    db.expire_all()
    rows = db.query(_R).filter(_R.target_type == _RT.PROCESS_NODE.value, _R.target_id == nodes[0].id).all()
    assert rows == []
```

- [ ] **Step 2: Run, verify FAIL** (delete leaves the orphan review → approved count or row lingers): `cd backend && .venv/bin/pytest tests/test_stakeholder_review.py::test_deleted_node_review_is_removed -q`

- [ ] **Step 3: Add cleanup to `delete_node`** in `backend/app/api/v2/process_maps.py`. Add the `Review` import to the `app.models.workflow` import (add the line if absent: `from app.models.workflow import Review`) and the `ReviewTargetType` to the `app.enums` import. Then in `delete_node`, before `db.delete(node)`:
```python
    db.execute(
        delete(Review).where(
            Review.target_type == ReviewTargetType.PROCESS_NODE.value,
            Review.target_id == node_id,
        )
    )
```
Add `delete` to the `from sqlalchemy import ...` line (currently `func, or_, select, update` → add `delete`).

- [ ] **Step 4: Run, verify pass:** `cd backend && .venv/bin/pytest tests/test_stakeholder_review.py -q` → 8 passed.

- [ ] **Step 5: Commit**
```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_stakeholder_review.py
git commit -m "feat(sp3): drop a node's review rows when the node is deleted

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Frontend foundation — types + api methods + review-summary helper (TDD)

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`
- Create: `src/components/canvas/review-summary.ts`
- Create: `src/components/canvas/review-summary.test.ts`

- [ ] **Step 1: Write the failing Vitest** — `src/components/canvas/review-summary.test.ts`:
```ts
import { describe, expect, it } from "vitest";

import { bucketNodes, reviewByNodeMap } from "./review-summary";
import type { NodeReview } from "@/lib/types";

const reviews: NodeReview[] = [
  { node_id: "a", status: "approved", note: null },
  { node_id: "b", status: "changes_requested", note: "fix" },
];
const nodes = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" },
];

describe("reviewByNodeMap", () => {
  it("maps node id to decision", () => {
    expect(reviewByNodeMap(reviews)).toEqual({ a: "approved", b: "changes_requested" });
  });
  it("empty in, empty out", () => {
    expect(reviewByNodeMap([])).toEqual({});
  });
});

describe("bucketNodes", () => {
  it("sorts nodes into approved / changesRequested / pending", () => {
    const r = bucketNodes(nodes, reviewByNodeMap(reviews));
    expect(r.approved.map((n) => n.id)).toEqual(["a"]);
    expect(r.changesRequested.map((n) => n.id)).toEqual(["b"]);
    expect(r.pending.map((n) => n.id)).toEqual(["c"]);
  });
  it("all pending when no reviews", () => {
    const r = bucketNodes(nodes, {});
    expect(r.pending).toHaveLength(3);
    expect(r.approved).toHaveLength(0);
    expect(r.changesRequested).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL:** `npm test -- review-summary` (cannot resolve module).

- [ ] **Step 3: Add the types** to `src/lib/types.ts`:
```ts
export type ReviewDecision = "approved" | "changes_requested";

export interface NodeReview {
  node_id: UUID;
  status: ReviewDecision;
  note: string | null;
}

export interface ReviewCounts {
  approved: number;
  changes_requested: number;
  pending: number;
  total: number;
}

export interface ReviewState {
  version_id: UUID;
  version_status: string;
  request_status: string | null;
  nodes: NodeReview[];
  counts: ReviewCounts;
}

export interface NodeReviewUpdate {
  status: ReviewDecision;
  note?: string;
}
```

- [ ] **Step 4: Create the pure helper** — `src/components/canvas/review-summary.ts`:
```ts
import type { NodeReview, ReviewDecision } from "@/lib/types";

export type ReviewByNode = Record<string, ReviewDecision>;

export function reviewByNodeMap(reviews: NodeReview[]): ReviewByNode {
  const out: ReviewByNode = {};
  for (const r of reviews) out[r.node_id] = r.status;
  return out;
}

export interface NamedNode {
  id: string;
  name: string;
}

export function bucketNodes(
  nodes: NamedNode[],
  byNode: ReviewByNode
): { approved: NamedNode[]; changesRequested: NamedNode[]; pending: NamedNode[] } {
  const approved: NamedNode[] = [];
  const changesRequested: NamedNode[] = [];
  const pending: NamedNode[] = [];
  for (const n of nodes) {
    const d = byNode[n.id];
    if (d === "approved") approved.push(n);
    else if (d === "changes_requested") changesRequested.push(n);
    else pending.push(n);
  }
  return { approved, changesRequested, pending };
}
```

- [ ] **Step 5: Add the api methods** to `src/lib/api.ts` (on the `api` object; import the new types at the top with the other type imports). Follow the existing `request<T>` style:
```ts
  getReviewState: (projectId: UUID, modelId: UUID, versionId: UUID) =>
    request<ReviewState>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/review`
    ),
  setNodeReview: (projectId: UUID, nodeId: UUID, body: NodeReviewUpdate) =>
    request<NodeReview>(`/api/v2/projects/${projectId}/nodes/${nodeId}/review`, {
      method: "PATCH",
      json: body,
    }),
  requestReview: (projectId: UUID, modelId: UUID, versionId: UUID) =>
    request<ReviewState>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/review/request`,
      { method: "POST" }
    ),
```
(Ensure `ReviewState`, `NodeReview`, `NodeReviewUpdate` are imported in `api.ts`.)

- [ ] **Step 6: Run, verify PASS + gates:** `npm test -- review-summary` (green); `npx tsc --noEmit` (clean); `npm test` (full — confirm no regressions).

- [ ] **Step 7: Commit**
```bash
git add src/lib/types.ts src/lib/api.ts src/components/canvas/review-summary.ts src/components/canvas/review-summary.test.ts
git commit -m "feat(sp3): FE review types, api methods, review-summary helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend — page review query + mutations + Properties panel wiring

> No pure unit test (React wiring). Gate: `npx tsc --noEmit` + `npm run build` + manual.

**Files:**
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx`
- Modify: `src/components/canvas/properties-panel.tsx`

- [ ] **Step 1: Page — add the review query, the reviewByNode map, and mutations.** In the version page, after the existing `issues` query:
```ts
  const { data: reviewState } = useQuery({
    queryKey: ["review", params.id, params.modelId, params.versionId],
    queryFn: () => api.getReviewState(params.id, params.modelId, params.versionId),
    enabled: !!data,
  });

  const reviewByNode = useMemo<Record<string, ReviewDecision>>(
    () => reviewByNodeMap(reviewState?.nodes ?? []),
    [reviewState]
  );

  const invalidateReview = () =>
    queryClient.invalidateQueries({
      queryKey: ["review", params.id, params.modelId, params.versionId],
    });

  const setNodeReviewMutation = useMutation({
    mutationFn: (vars: { nodeId: UUID; body: NodeReviewUpdate }) =>
      api.setNodeReview(params.id, vars.nodeId, vars.body),
    onSuccess: invalidateReview,
  });

  const requestReviewMutation = useMutation({
    mutationFn: () => api.requestReview(params.id, params.modelId, params.versionId),
    onSuccess: invalidateReview,
  });
```
Add imports: `useMutation` from `@tanstack/react-query` (alongside `useQuery`); `reviewByNodeMap` from `@/components/canvas/review-summary`; types `ReviewDecision`, `NodeReviewUpdate` from `@/lib/types`; ensure `useMemo` is imported.

- [ ] **Step 2: Page — pass `review` to PropertiesPanel.** In the `<PropertiesPanel ... />` block, add:
```tsx
            review={
              selectedNode
                ? {
                    status: reviewByNode[selectedNode.id] ?? null,
                    onApprove: () =>
                      setNodeReviewMutation.mutate({
                        nodeId: selectedNode.id,
                        body: { status: "approved" },
                      }),
                    onRequestChange: (note?: string) =>
                      setNodeReviewMutation.mutate({
                        nodeId: selectedNode.id,
                        body: { status: "changes_requested", note },
                      }),
                  }
                : undefined
            }
```

- [ ] **Step 3: Properties panel — accept the prop + wire the buttons.** In `src/components/canvas/properties-panel.tsx`:

Add to the imports:
```ts
import { useState } from "react"; // already imported — ensure useState is present
import type { ReviewDecision } from "@/lib/types";
```
Add to the component props type (alongside `onUpdate`):
```ts
  review?: {
    status: ReviewDecision | null;
    onApprove: () => void;
    onRequestChange: (note?: string) => void;
  };
```
Add local state near the other `useState`s:
```ts
  const [changeNote, setChangeNote] = useState("");
  const [showChangeNote, setShowChangeNote] = useState(false);
```
Replace the "Stakeholder Review" section body (the `Not yet assigned.` line + the 3-button row, lines ~327-354) with:
```tsx
        <div className="mb-2 text-[11px] italic">
          {review?.status === "approved" ? (
            <span className="text-emerald-600">Approved</span>
          ) : review?.status === "changes_requested" ? (
            <span className="text-amber-600">Changes requested</span>
          ) : (
            <span className="text-slate-400">Not yet reviewed</span>
          )}
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            disabled={!review}
            onClick={() => review?.onApprove()}
            className="flex-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10.5px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={!review}
            onClick={() => setShowChangeNote((v) => !v)}
            className="flex-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[10.5px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
          >
            Request change
          </button>
          <button
            type="button"
            disabled
            title="Assigning reviewers needs multi-user accounts (coming later)"
            className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10.5px] font-semibold text-slate-400 cursor-not-allowed"
          >
            @ Assign
          </button>
        </div>
        {showChangeNote && review && (
          <div className="mt-2">
            <textarea
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              placeholder="Optional note for the change request…"
              rows={2}
              className="w-full rounded-md border border-slate-200 px-2 py-1 text-[11px] focus:border-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                review.onRequestChange(changeNote.trim() || undefined);
                setChangeNote("");
                setShowChangeNote(false);
              }}
              className="mt-1 w-full rounded-md bg-rose-600 px-2 py-1 text-[10.5px] font-semibold text-white hover:bg-rose-700"
            >
              Submit change request
            </button>
          </div>
        )}
```
(Keep the section's outer wrapper `<div className="border-t …">` + the "Stakeholder Review" heading.)

- [ ] **Step 4: Gates:** `npx tsc --noEmit` (clean) + `npm run build` (succeeds).

- [ ] **Step 5: Commit**
```bash
git add "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx" src/components/canvas/properties-panel.tsx
git commit -m "feat(sp3): per-node approve / request-change wired into Properties panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Frontend — Review tab (real meter, buckets, send request)

> Gate: `npx tsc --noEmit` + `npm run build` + manual.

**Files:**
- Modify: `src/components/canvas/right-panel.tsx` (`RightPanel` props + `ReviewTab` ~lines 562-617)
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` (pass props to RightPanel)

- [ ] **Step 1: RightPanel — thread new props.** In `src/components/canvas/right-panel.tsx`, add to `RightPanel`'s destructured params + props type (near `onFocusNode`):
```ts
  reviewState,
  onSendRequest,
```
```ts
  reviewState?: ReviewState;
  onSendRequest: () => void;
```
Import `ReviewState` from `@/lib/types`, and `bucketNodes` from `./review-summary`. Update the render line (was `{tab === "review" && <ReviewTab nodes={nodes} onFocusNode={onFocusNode} />}`):
```tsx
        {tab === "review" && (
          <ReviewTab
            nodes={nodes}
            onFocusNode={onFocusNode}
            reviewState={reviewState}
            onSendRequest={onSendRequest}
          />
        )}
```

- [ ] **Step 2: Rewrite `ReviewTab`** (lines ~563-617) to use real data:
```tsx
function ReviewTab({
  nodes,
  onFocusNode,
  reviewState,
  onSendRequest,
}: {
  nodes: { id: UUID; name: string }[];
  onFocusNode: (id: UUID) => void;
  reviewState?: ReviewState;
  onSendRequest: () => void;
}) {
  const total = reviewState?.counts.total ?? nodes.length;
  const approved = reviewState?.counts.approved ?? 0;
  const changes = reviewState?.counts.changes_requested ?? 0;
  const pct = total === 0 ? 0 : Math.round((approved / total) * 100);
  const byNode = reviewByNodeMap(reviewState?.nodes ?? []);
  const buckets = bucketNodes(nodes, byNode);
  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <div className="mb-3 rounded-lg bg-gradient-to-br from-slate-800 to-slate-900 p-3 text-white">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Sign-off progress
        </div>
        <div className="mb-2 flex items-baseline gap-1.5">
          <span className="text-2xl font-bold tabular-nums">{approved}</span>
          <span className="text-xs text-slate-400">of {total} steps approved</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
          <div className="h-full bg-emerald-400 transition-all" style={{ width: `${pct}%` }} />
        </div>
        {reviewState?.request_status && (
          <div className="mt-2 text-[10px] uppercase tracking-wider text-slate-400">
            Status: {reviewState.version_status}
          </div>
        )}
        <button
          type="button"
          disabled={total === 0}
          onClick={onSendRequest}
          className="mt-2.5 w-full rounded-md bg-emerald-600 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500"
        >
          Send review request to stakeholders
        </button>
      </div>

      <Bucket title="Changes requested" count={changes} colorDot="bg-rose-500" items={buckets.changesRequested} onFocusNode={onFocusNode} />
      <Bucket title="Pending" count={buckets.pending.length} colorDot="bg-slate-400" items={buckets.pending} onFocusNode={onFocusNode} />
      <Bucket title="Approved" count={approved} colorDot="bg-emerald-500" items={buckets.approved} onFocusNode={onFocusNode} />
    </div>
  );
}
```
Import `ReviewState` from `@/lib/types`, and `bucketNodes`, `reviewByNodeMap` from `./review-summary` (top of `right-panel.tsx`). Delete the old hardcoded buckets + the "isn't persisted yet" footer disclaimer.

- [ ] **Step 3: Page — pass props to `<RightPanel>`.** Find the `<RightPanel ... />` render in the page and add:
```tsx
          reviewState={reviewState}
          onSendRequest={() => requestReviewMutation.mutate()}
```

- [ ] **Step 4: Gates:** `npx tsc --noEmit` + `npm run build`.

- [ ] **Step 5: Commit**
```bash
git add src/components/canvas/right-panel.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(sp3): Review tab — real sign-off meter, buckets, send request

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Frontend — review-mode per-node badge overlay

> Gate: `npx tsc --noEmit` + `npm run build` + manual. Mirrors the existing `issueLevel` badge plumbing.

**Files:**
- Modify: `src/components/canvas/shapes.tsx` (`NodeShape`)
- Modify: `src/components/canvas/bpmn-canvas.tsx` (prop + pass-through)
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` (pass `reviewByNode`)

- [ ] **Step 1: `NodeShape` — add a `reviewBadge` prop + render it** (top-LEFT corner, so it can't collide with the top-right issue badge). In `src/components/canvas/shapes.tsx`, add `reviewBadge` to the destructured props + type:
```ts
  reviewBadge,
```
```ts
  reviewBadge?: "approved" | "changes_requested" | null;
```
After the existing `{issueLevel && ( … )}` badge block (ends ~line 311), add:
```tsx
      {reviewBadge && (
        <g transform={`translate(8, -8)`} style={{ pointerEvents: "none" }}>
          <circle
            r={9}
            fill={reviewBadge === "approved" ? "#10b981" : "#f59e0b"}
            stroke="#fff"
            strokeWidth={2}
          />
          <text textAnchor="middle" y={4} fontSize="11" fontWeight="700" fill="#fff">
            {reviewBadge === "approved" ? "✓" : "!"}
          </text>
        </g>
      )}
```

- [ ] **Step 2: `BpmnCanvas` — add the `reviewByNode` prop + pass it through.** In `src/components/canvas/bpmn-canvas.tsx`:
- Add to `BpmnCanvasProps` (near `issuesByNode`):
```ts
  reviewByNode?: Record<string, "approved" | "changes_requested">;
```
- Destructure it in the component params (near `issuesByNode`).
- Add near `issuesMap` (~line 207):
```ts
  const reviewMap = reviewByNode ?? {};
```
- In the `renderNodes.map(...) <NodeShape>` JSX (~line 1766-1776), add:
```tsx
              reviewBadge={reviewMode ? reviewMap[node.id] ?? null : null}
```
(`reviewMode` is the existing state at line ~199.)

- [ ] **Step 2b: TDZ note** — `reviewMap` is a plain `const` derived from a prop at the top of the component body; no callback/effect dependency-array involvement, so no TDZ concern. Do not add it to any dependency array.

- [ ] **Step 3: Page — pass `reviewByNode` to `<BpmnCanvas>`.** In the `<BpmnCanvas ... />` block, add:
```tsx
          reviewByNode={reviewByNode}
```

- [ ] **Step 4: Gates:** `npx tsc --noEmit` + `npm run build`.

- [ ] **Step 5: Commit**
```bash
git add src/components/canvas/shapes.tsx src/components/canvas/bpmn-canvas.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(sp3): review-mode per-node status badge overlay

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full verification

**Files:** none (fix-forward if issues found).

- [ ] **Step 1: Backend** — `cd backend && .venv/bin/pytest tests/test_stakeholder_review.py -q` (8 passed); then full suite `.venv/bin/pytest -q`.
- [ ] **Step 2: Frontend gates** — `npx tsc --noEmit` (clean) + `npm test` (Vitest green incl. `review-summary`) + `npm run build` (succeeds).
- [ ] **Step 3: Live API smoke** (app running via `./run-local.sh`): against a real version — POST `…/review/request` (version→review), PATCH two nodes' `…/review` to approved (version→approved), GET `…/review` confirms counts; restore by deleting test reviews if needed (or use a throwaway version).
- [ ] **Step 4: Manual UI** (`./run-local.sh`): select a node → Approve → meter ticks, badge shows in review mode; Request change + note → amber badge, note persists in panel; Send review request → version shows `review`; approve all nodes → `approved`; reload → state persists; @ Assign disabled with tooltip.
- [ ] **Step 5:** Record any deferred follow-ups in this plan; commit if added.

---

## Self-review notes (author)

- **Spec coverage:** GET/PATCH/POST endpoints (Tasks 1-2) ✓; auto-transition (`_recompute_version_status`, Task 2) ✓; orphan cleanup (Task 3) ✓; per-node panel wiring + Assign-disabled (Task 5) ✓; Review-tab meter/buckets/send (Task 6) ✓; review-mode overlay (Task 7) ✓; pure helper + Vitest (Task 4) ✓; no migration (tables pre-exist) ✓.
- **Type consistency:** `ReviewState`/`NodeReview`/`NodeReviewUpdate`/`ReviewDecision` defined in Task 4, consumed in 5-7; `reviewByNodeMap`/`bucketNodes` defined in Task 4, used in 5/6; `reviewByNode` prop name consistent page→canvas (Task 7); endpoint URLs identical between api.ts (Task 4) and routes (Tasks 1-2).
- **Verify-against-source reminders:** the `<RightPanel>` render call in the page (Task 6 Step 3) and the exact `delete_node` / sqlalchemy-import lines (Task 3 Step 3) should be confirmed by reading before editing. The Properties "Stakeholder Review" section line range (Task 5 Step 3) is approximate — match the actual JSX.
