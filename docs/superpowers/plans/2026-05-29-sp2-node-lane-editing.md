# SP-2 — Node + Lane Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the node Type dropdown functional (change a node's BPMN type, undoable, provenance preserved) and add persisted per-lane color + collapse state.

**Architecture:** Both edits ride SP-1's existing plumbing — node edits go through a `*Local` mutator + `record({do,undo})` (undo stack); lane edits go through `setLanes` + debounced `markLane` (persistence hook) + `record`. Widening the `NodeUpdate`/`LaneUpdate` interfaces is all the persistence hook needs. One Alembic migration adds two lane columns; `node.type` is already a free `String(40)` so type needs no migration.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic + pytest (backend, Postgres on :5433, `poet_test` db); Next.js 16 + React 19 + TypeScript + Vitest (frontend). Binding gates: `npx tsc --noEmit`, `npm test`, `npm run build`, backend `pytest`, and manual via `./run-local.sh`. Lint is advisory (see the frontend-lint-baseline memory).

**Reference spec:** `docs/superpowers/specs/2026-05-29-sp2-node-lane-editing-design.md`

**Commit discipline:** commit locally after each task; do NOT push (pushes are user-gated). End every commit message with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 1: Backend — node `type` editing (schema + route + tests)

**Files:**
- Modify: `backend/app/schemas/process_map.py` (`NodeUpdate`, ~line 48-52)
- Modify: `backend/app/api/v2/process_maps.py` (`update_node`, ~line 528-537)
- Create: `backend/tests/test_node_lane_editing.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_node_lane_editing.py`. This file's seed helper is reused by Task 2, so build it completely now. Model the seeding on `backend/tests/test_process_detection_api.py` (TestClient + `get_db` override + `dev@local` user whose org owns the project).

```python
"""Integration tests for SP-2 node-type and lane color/collapse editing."""
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
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


def _seed_map(db):
    """Create org/dev-user/project + a one-lane, one-node process version with
    a claim linked to the node (to assert provenance survives a type change).
    Returns (project, version, lane, node, claim)."""
    org = Organization(name="t")
    db.add(org)
    db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    model = ProcessModel(project_id=proj.id, name="m", level="L1")
    db.add(model)
    db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(version)
    db.flush()
    lane = ProcessLane(version_id=version.id, name="Lane A", order_index=0, height_px=150)
    db.add(lane)
    db.flush()
    node = ProcessNode(
        version_id=version.id,
        lane_id=lane.id,
        type="task",
        name="Do work",
        position={"x": 120.0, "relative_y": 40.0},
        properties={},
    )
    db.add(node)
    db.flush()
    # A claim linked to the node — its link must survive a type change.
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
    db.flush()
    claim = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9)
    db.add(claim)
    db.flush()
    db.add(ClaimCitation(claim_id=claim.id, chunk_id=ch.id, quote="a", confidence=0.9))
    db.add(NodeClaimLink(node_id=node.id, claim_id=claim.id))
    db.commit()
    return proj, version, lane, node, claim


def test_patch_node_type_persists(client, db):
    proj, _version, _lane, node, _claim = _seed_map(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}",
        json={"type": "gateway_exclusive"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["type"] == "gateway_exclusive"
    db.expire_all()
    assert db.get(ProcessNode, node.id).type == "gateway_exclusive"


def test_patch_node_type_invalid_rejected(client, db):
    proj, _v, _l, node, _c = _seed_map(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}",
        json={"type": "bogus_type"},
    )
    assert resp.status_code == 422, resp.text


def test_patch_node_type_preserves_claim_links(client, db):
    proj, _v, _l, node, claim = _seed_map(db)
    client.patch(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}",
        json={"type": "subprocess"},
    )
    db.expire_all()
    links = (
        db.query(NodeClaimLink).filter(NodeClaimLink.node_id == node.id).all()
    )
    assert len(links) == 1
    assert links[0].claim_id == claim.id
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_node_lane_editing.py -q`
Expected: `test_patch_node_type_persists` and `..._preserves_claim_links` FAIL (the PATCH ignores `type`, so type stays `"task"`); `..._invalid_rejected` may already 200 (no validation yet) → also FAIL. (If Postgres on :5433 isn't up, start it with `./run-local.sh` first.)

- [ ] **Step 3: Add `type` to `NodeUpdate`**

In `backend/app/schemas/process_map.py`, change `NodeUpdate` (currently):
```python
class NodeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=500)
    lane_id: UUID | None = None
    x: float | None = None
    relative_y: float | None = None
```
to add the `type` field with the same allow-list `NodeCreate.type` uses:
```python
class NodeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=500)
    lane_id: UUID | None = None
    x: float | None = None
    relative_y: float | None = None
    type: str | None = Field(
        default=None,
        pattern=r"^(task|event_start|event_end|event_intermediate|gateway_exclusive|gateway_parallel|gateway_inclusive|subprocess)$",
    )
```

- [ ] **Step 4: Apply `type` in `update_node`**

In `backend/app/api/v2/process_maps.py`, inside `update_node`, after the `if payload.name is not None:` block and before the position block, add:
```python
    if payload.type is not None:
        node.type = payload.type
```
(Do not touch `node_claim_links` — provenance is preserved by leaving links alone.)

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_node_lane_editing.py -q`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas/process_map.py backend/app/api/v2/process_maps.py backend/tests/test_node_lane_editing.py
git commit -m "feat(sp2): node type editing — PATCH /nodes accepts type, preserves claim links

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend — lane `color` + `collapsed` (model + migration + schema + route + tests)

**Files:**
- Modify: `backend/app/models/process.py` (`ProcessLane`, ~line 73-91)
- Create: `backend/alembic/versions/0007_lane_color_collapsed.py`
- Modify: `backend/app/schemas/process_map.py` (`ProcessLaneRead`, `LaneCreate`, `LaneUpdate`)
- Modify: `backend/app/api/v2/process_maps.py` (`update_lane` ~line 684-689; `add_lane` ~line 700-730)
- Modify: `backend/tests/test_node_lane_editing.py` (append lane tests)

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_node_lane_editing.py`:
```python
from sqlalchemy import text as _sa_text


def test_lane_columns_exist(test_engine):
    with test_engine.connect() as conn:
        rows = conn.execute(
            _sa_text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='process_lanes' AND column_name IN ('color','collapsed')"
            )
        ).fetchall()
    assert {r[0] for r in rows} == {"color", "collapsed"}


def test_patch_lane_color_and_collapsed(client, db):
    proj, _v, lane, _n, _c = _seed_map(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/lanes/{lane.id}",
        json={"color": "#aabbcc", "collapsed": True},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["color"] == "#aabbcc"
    assert body["collapsed"] is True
    db.expire_all()
    fresh = db.get(ProcessLane, lane.id)
    assert fresh.color == "#aabbcc"
    assert fresh.collapsed is True


def test_patch_lane_color_invalid_rejected(client, db):
    proj, _v, lane, _n, _c = _seed_map(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/lanes/{lane.id}",
        json={"color": "red"},
    )
    assert resp.status_code == 422, resp.text


def test_lane_read_defaults_when_unset(client, db):
    proj, version, _lane, _n, _c = _seed_map(db)
    resp = client.get(
        f"/api/v2/projects/{proj.id}/process-maps/{version.model_id}/versions/{version.id}/graph"
    )
    assert resp.status_code == 200, resp.text
    lane0 = resp.json()["lanes"][0]
    assert lane0["color"] is None
    assert lane0["collapsed"] is False
```

> **Note on the graph URL:** the last test calls the existing graph endpoint. Confirm its exact path/shape with `grep -n "graph" backend/app/api/v2/process_maps.py` and adjust the URL/JSON key if it differs (it returns `lanes` validated via `ProcessLaneRead`).

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_node_lane_editing.py -q`
Expected: the four new tests FAIL — `test_lane_columns_exist` (no columns yet), the PATCH/read tests (schema/route don't know the fields). The migration in Step 4 runs at the session fixture's `alembic upgrade head`, so the column test only passes once the migration exists.

- [ ] **Step 3: Add the model columns**

In `backend/app/models/process.py`, add `Boolean` to the SQLAlchemy import line:
```python
from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text, UniqueConstraint
```
Then in `ProcessLane`, after the `height_px` column, add:
```python
    color: Mapped[str | None] = mapped_column(String(9), nullable=True)
    collapsed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
```

- [ ] **Step 4: Create the Alembic migration**

Create `backend/alembic/versions/0007_lane_color_collapsed.py` (down_revision is the current head `0006_detection_run_updated_at`):
```python
"""add color and collapsed to process_lanes

Revision ID: 0007_lane_color_collapsed
Revises: 0006_detection_run_updated_at
Create Date: 2026-05-29

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007_lane_color_collapsed"
down_revision: Union[str, None] = "0006_detection_run_updated_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "process_lanes",
        sa.Column("color", sa.String(length=9), nullable=True),
    )
    op.add_column(
        "process_lanes",
        sa.Column(
            "collapsed",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("process_lanes", "collapsed")
    op.drop_column("process_lanes", "color")
```

Verify the head before/after: `cd backend && .venv/bin/alembic heads` should now show `0007_lane_color_collapsed`. (The conftest session fixture runs `alembic upgrade head` against `poet_test`; if a prior session already migrated, the new revision applies on next run automatically.)

- [ ] **Step 5: Update the schemas**

In `backend/app/schemas/process_map.py`:

`ProcessLaneRead` — add the two fields:
```python
class ProcessLaneRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    order_index: int
    height_px: int
    color: str | None = None
    collapsed: bool = False
```

`LaneCreate` — add optional color:
```python
class LaneCreate(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    order_index: int = Field(ge=0)
    height_px: int | None = Field(default=None, ge=80)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
```

`LaneUpdate` — add color + collapsed:
```python
class LaneUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    order_index: int | None = Field(default=None, ge=0)
    height_px: int | None = Field(default=None, ge=80)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    collapsed: bool | None = None
```

- [ ] **Step 6: Apply the fields in the routes**

In `update_lane` (after the `height_px` block):
```python
    if payload.color is not None:
        lane.color = payload.color
    if payload.collapsed is not None:
        lane.collapsed = payload.collapsed
```

In `add_lane`, where `ProcessLane(...)` is constructed (currently passes `height_px=payload.height_px or 150`), add `color=payload.color` to the constructor kwargs.

- [ ] **Step 7: Run the tests, verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_node_lane_editing.py -q`
Expected: all tests pass (7 total across Tasks 1–2). If `test_lane_columns_exist` fails because the session DB was migrated before 0007 existed, drop+recreate the test DB or run `DATABASE_URL=postgresql+psycopg://poet:poet@localhost:5433/poet_test backend/.venv/bin/alembic upgrade head` once, then re-run.

- [ ] **Step 8: Commit**

```bash
git add backend/app/models/process.py backend/alembic/versions/0007_lane_color_collapsed.py backend/app/schemas/process_map.py backend/app/api/v2/process_maps.py backend/tests/test_node_lane_editing.py
git commit -m "feat(sp2): persist lane color + collapsed (model, migration 0007, schema, route)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Frontend foundation — types, layout exports, node-type helper (TDD)

**Files:**
- Modify: `src/lib/types.ts` (`NodeUpdate`, `ProcessLane`, `LaneUpdate`)
- Modify: `src/components/canvas/types.ts` (`CanvasLane`)
- Modify: `src/components/canvas/layout.ts` (export helpers; `buildCanvasState`)
- Create: `src/components/canvas/node-type.ts`
- Create: `src/components/canvas/node-type.test.ts`

- [ ] **Step 1: Write the failing Vitest**

Create `src/components/canvas/node-type.test.ts`:
```ts
import { describe, expect, it } from "vitest";

import { NODE_TYPE_OPTIONS, sizeForNodeType } from "./node-type";

// Mirrors the backend NodeUpdate/NodeCreate allow-list.
const BACKEND_TYPES = [
  "task",
  "event_start",
  "event_end",
  "event_intermediate",
  "gateway_exclusive",
  "gateway_parallel",
  "gateway_inclusive",
  "subprocess",
];

describe("NODE_TYPE_OPTIONS", () => {
  it("offers exactly the backend NodeType values", () => {
    const values = NODE_TYPE_OPTIONS.map((o) => o.value).sort();
    expect(values).toEqual([...BACKEND_TYPES].sort());
  });

  it("gives every option a non-empty label", () => {
    for (const o of NODE_TYPE_OPTIONS) {
      expect(o.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("sizeForNodeType", () => {
  it("sizes gateways at 60x60", () => {
    expect(sizeForNodeType("gateway_exclusive")).toEqual({ w: 60, h: 60 });
    expect(sizeForNodeType("gateway_parallel")).toEqual({ w: 60, h: 60 });
  });

  it("sizes tasks/subprocess at 170x64", () => {
    expect(sizeForNodeType("task")).toEqual({ w: 170, h: 64 });
    expect(sizeForNodeType("subprocess")).toEqual({ w: 170, h: 64 });
  });

  it("sizes events at 50x50", () => {
    expect(sizeForNodeType("event_start")).toEqual({ w: 50, h: 50 });
    expect(sizeForNodeType("event_end")).toEqual({ w: 50, h: 50 });
    expect(sizeForNodeType("event_intermediate")).toEqual({ w: 50, h: 50 });
  });

  it("falls back to task size for unknown types", () => {
    expect(sizeForNodeType("nonsense")).toEqual({ w: 170, h: 64 });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- node-type`
Expected: FAIL — `Cannot find module './node-type'` (file not created yet).

- [ ] **Step 3: Export the layout helpers**

In `src/components/canvas/layout.ts`, change three declarations from module-private to exported:
- `const NODE_SIZES` → `export const NODE_SIZES`
- `const LANE_PALETTE` → `export const LANE_PALETTE`
- `function nodeKindFromType` → `export function nodeKindFromType`

- [ ] **Step 4: Create the node-type helper**

Create `src/components/canvas/node-type.ts`:
```ts
import { NODE_SIZES, nodeKindFromType } from "./layout";

/** The 8 backend NodeType values, with friendly labels for the Type dropdown.
 * Kept in sync with the backend NodeUpdate/NodeCreate allow-list regex. */
export const NODE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "task", label: "Task" },
  { value: "subprocess", label: "Subprocess" },
  { value: "event_start", label: "Start event" },
  { value: "event_end", label: "End event" },
  { value: "event_intermediate", label: "Intermediate event" },
  { value: "gateway_exclusive", label: "Exclusive gateway" },
  { value: "gateway_parallel", label: "Parallel gateway" },
  { value: "gateway_inclusive", label: "Inclusive gateway" },
];

/** Box dimensions for a backend NodeType, resolved via its visual kind. */
export function sizeForNodeType(type: string): { w: number; h: number } {
  return NODE_SIZES[nodeKindFromType(type)];
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- node-type`
Expected: PASS (all node-type tests green).

- [ ] **Step 6: Widen the shared + canvas types**

In `src/lib/types.ts`:
- `NodeUpdate` interface — add `type?: string;`
- `ProcessLane` interface — add `color: string | null;` and `collapsed: boolean;`
- `LaneUpdate` interface — add `color?: string;` and `collapsed?: boolean;`

In `src/components/canvas/types.ts`, `CanvasLane` — add `collapsed: boolean;`

- [ ] **Step 7: Populate color + collapsed in `buildCanvasState`**

In `src/components/canvas/layout.ts`, in the lane-building loop, change:
```ts
    lanes.push({
      id: l.id,
      label: l.name,
      color: LANE_PALETTE[i % LANE_PALETTE.length],
      y: runningY,
      h,
    });
```
to:
```ts
    lanes.push({
      id: l.id,
      label: l.name,
      color: l.color ?? LANE_PALETTE[i % LANE_PALETTE.length],
      collapsed: l.collapsed ?? false,
      y: runningY,
      h,
    });
```

- [ ] **Step 8: Typecheck, test, commit**

Run: `npx tsc --noEmit && npm test -- node-type`
Expected: tsc clean (no new errors beyond the baseline), node-type tests pass.
```bash
git add src/lib/types.ts src/components/canvas/types.ts src/components/canvas/layout.ts src/components/canvas/node-type.ts src/components/canvas/node-type.test.ts
git commit -m "feat(sp2): FE foundation — type/lane fields, layout exports, node-type helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Frontend — functional Type dropdown

> No pure-unit test is feasible here (React/DOM + canvas wiring). Binding gate is `npx tsc --noEmit` + `npm run build` + manual. The pure logic (`sizeForNodeType`) is already covered by Task 3's Vitest.

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx` (selection union ~line 141; `BpmnCanvasHandle.updateNode` ~line 151-154; `onSelectionChange` node payload ~line 590-596; add `applyNodeTypeLocal` near `applyNodeEditLocal` ~line 269; `updateNodeImpl` ~line 295-331)
- Modify: `src/components/canvas/properties-panel.tsx` (`SelectedNode` ~line 21-26; `onUpdate` prop type ~line 57-60; Type `<select>` ~line 191-208)
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` (`handleNodeUpdate` ~line 76-92)

- [ ] **Step 1: Thread `type` through the selection union + handle**

In `bpmn-canvas.tsx`, change the node variant of `CanvasSelection`:
```ts
  | { kind: "node"; id: UUID; name?: string; nodeKind?: string; type?: string; laneId?: UUID | null }
```
And widen the `updateNode` handle signature:
```ts
  updateNode: (
    id: UUID,
    patch: { name?: string; laneId?: UUID; type?: string }
  ) => Promise<void>;
```

- [ ] **Step 2: Pass `type` in the selection payload**

In the selection `useEffect`, add `type: node.type,` to the single-node `onSelectionChange({ kind: "node", ... })` object:
```ts
        onSelectionChange({
          kind: "node",
          id,
          name: node.label,
          nodeKind: node.kind,
          type: node.type,
          laneId: node.laneId,
        });
```

- [ ] **Step 3: Add `applyNodeTypeLocal`**

Add the import at the top of `bpmn-canvas.tsx` (alongside the existing layout import):
```ts
import { nodeKindFromType } from "./layout";
import { sizeForNodeType } from "./node-type";
```
(If a `./layout` import already exists, add `nodeKindFromType` to it instead of a second import line.)

Immediately after `applyNodeEditLocal` (the `useCallback` ending ~line 293), add:
```ts
  const applyNodeTypeLocal = useCallback(
    async (id: UUID, newType: string) => {
      const kind = nodeKindFromType(newType);
      const size = sizeForNodeType(newType);
      setNodes((curr) =>
        curr.map((n) =>
          n.id === id
            ? { ...n, type: newType, kind, w: size.w, h: size.h }
            : n
        )
      );
      await api.updateNode(projectId, id, { type: newType });
    },
    [projectId]
  );
```
(Keeps `x`/`relativeY` untouched — no reflow, per spec.)

- [ ] **Step 4: Add the type branch to `updateNodeImpl`**

At the **top** of `updateNodeImpl`'s body (right after `const old = nodesRef.current.find((n) => n.id === id); if (!old) return;`), add a self-contained type branch that returns before the name/lane logic:
```ts
      if (patch.type !== undefined && patch.type !== old.type) {
        const newType = patch.type;
        const oldType = old.type;
        await applyNodeTypeLocal(id, newType);
        record({
          description: "Change node type",
          do: () => applyNodeTypeLocal(id, newType),
          undo: () => applyNodeTypeLocal(id, oldType),
        });
        return;
      }
```
Update the patch parameter type to `{ name?: string; laneId?: UUID; type?: string }` and the dependency array to `[applyNodeEditLocal, applyNodeTypeLocal, record]`.

> **TDZ guard:** `applyNodeTypeLocal` is declared before `updateNodeImpl`, so listing it in the deps array is safe. Do NOT reference it from any effect/handle declared earlier in the component.

- [ ] **Step 5: Make the Properties Type dropdown functional**

In `properties-panel.tsx`:

Add the import:
```ts
import { NODE_TYPE_OPTIONS } from "./node-type";
```
Extend `SelectedNode`:
```ts
interface SelectedNode {
  id: UUID;
  name?: string;
  nodeKind?: string;
  type?: string;
  laneId?: string | null;
}
```
Extend the `onUpdate` prop type:
```ts
  onUpdate?: (
    id: UUID,
    patch: { name?: string; laneId?: UUID; type?: string }
  ) => Promise<void> | void;
```
Replace the disabled Type `<select>` block (the `<select value={selected.nodeKind ?? "user"} disabled ...>` with its `NODE_KINDS.map`) with:
```tsx
            <select
              value={selected.type ?? "task"}
              onChange={(e) =>
                onUpdate?.(selected.id, { type: e.target.value })
              }
              disabled={!onUpdate}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-slate-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
            >
              {NODE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
```
Then delete the now-unused `NODE_KINDS` const (~line 28-38).

- [ ] **Step 6: Thread `type` through the page handler**

In the version page, update `handleNodeUpdate`:
```ts
  const handleNodeUpdate = useCallback(
    async (id: UUID, patch: { name?: string; laneId?: UUID; type?: string }) => {
      if (!canvasRef.current) return;
      await canvasRef.current.updateNode(id, patch);
      // Reflect the new label/lane/type in the panel without forcing a re-select.
      setSelected((curr) =>
        curr.kind === "node" && curr.id === id
          ? {
              ...curr,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.laneId !== undefined ? { laneId: patch.laneId } : {}),
              ...(patch.type !== undefined ? { type: patch.type } : {}),
            }
          : curr
      );
    },
    []
  );
```

- [ ] **Step 7: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: tsc clean (no new errors vs baseline); build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx src/components/canvas/properties-panel.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(sp2): functional node Type dropdown (PATCH type, recompute kind/size, undoable)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend — lane color picker

> Gate: `npx tsc --noEmit` + `npm run build` + manual. The color control lives inside the existing lane options popover (the `isMenu` block), so no new outside-click handling is needed.

**Files:**
- Modify: `src/components/canvas/lane-rail.tsx` (props ~line 22-42; lane options menu ~line 411-495)
- Modify: `src/components/canvas/bpmn-canvas.tsx` (add `setLaneColorLocal`/`setLaneColor` near `renameLaneLocal` ~line 1499; pass `onSetColor` to `<LaneRail>` ~line 1785-1793)

- [ ] **Step 1: Add the `onSetColor` prop to LaneRail**

In `lane-rail.tsx`, add the import:
```ts
import { LANE_PALETTE } from "./layout";
```
Add `onSetColor` to both the destructured params and the props type:
```ts
export function LaneRail({
  lanes,
  viewport,
  onMoveLane,
  onResizeLane,
  onRenameLane,
  onAddLaneAt,
  onDeleteLane,
  onSetColor,
  collapsedLaneIds,
  onToggleCollapse,
}: {
  lanes: CanvasLane[];
  viewport: Viewport;
  onMoveLane: (laneId: string, targetIndex: number) => void;
  onResizeLane: (laneId: string, newH: number) => void;
  onRenameLane: (laneId: string, newName: string) => void;
  onAddLaneAt: (index: number) => void;
  onDeleteLane: (laneId: string) => void;
  onSetColor: (laneId: string, color: string) => void;
  collapsedLaneIds: Set<string>;
  onToggleCollapse: (laneId: string) => void;
}) {
```

- [ ] **Step 2: Add a color section to the lane options menu**

In the `isMenu` popover (`<div data-lane-menu ...>`), insert a color section after the "Rename lane" `MenuItem` and before the first divider. It renders the 8 palette swatches (current one ringed) plus a native custom-color input:
```tsx
                <div style={{ padding: "4px 6px 2px" }}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: "#64748b",
                      marginBottom: 4,
                    }}
                  >
                    Lane color
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 4,
                      alignItems: "center",
                    }}
                  >
                    {LANE_PALETTE.map((c) => {
                      const active =
                        (lane.color ?? "").toLowerCase() === c.toLowerCase();
                      return (
                        <button
                          key={c}
                          title={c}
                          onClick={() => {
                            onSetColor(lane.id, c);
                            setMenuFor(null);
                          }}
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: 4,
                            background: c,
                            border: active
                              ? "2px solid #0f172a"
                              : "1px solid #cbd5e1",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        />
                      );
                    })}
                    <label
                      title="Custom color"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        border: "1px dashed #94a3b8",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        fontSize: 12,
                        color: "#64748b",
                        position: "relative",
                        overflow: "hidden",
                      }}
                    >
                      +
                      <input
                        type="color"
                        value={lane.color ?? "#dbeafe"}
                        onChange={(e) => onSetColor(lane.id, e.target.value)}
                        style={{
                          position: "absolute",
                          inset: 0,
                          opacity: 0,
                          cursor: "pointer",
                        }}
                      />
                    </label>
                  </div>
                </div>
                <div
                  style={{ height: 1, background: "#f1f5f9", margin: "3px 2px" }}
                />
```
(Place this block immediately after the "Rename lane" `MenuItem` closing `/>`. Keep the existing dividers/items below as-is. The custom input commits live via `onChange`; it does not close the menu so the user can drag the picker — that's fine.)

- [ ] **Step 3: Add the undoable color mutators in the canvas**

In `bpmn-canvas.tsx`, after `renameLaneLocal` (~line 1507), add:
```ts
  const setLaneColorLocal = useCallback(
    (laneId: string, color: string) => {
      setLanes((curr) =>
        curr.map((l) => (l.id === laneId ? { ...l, color } : l))
      );
      markLane(laneId, { color });
    },
    [markLane]
  );

  const setLaneColor = useCallback(
    (laneId: string, color: string) => {
      const old = lanesRef.current.find((l) => l.id === laneId);
      if (!old || old.color === color) return;
      const oldColor = old.color;
      setLaneColorLocal(laneId, color);
      record({
        description: "Set lane color",
        do: () => setLaneColorLocal(laneId, color),
        undo: () => setLaneColorLocal(laneId, oldColor),
      });
    },
    [setLaneColorLocal, record]
  );
```
(`lanesRef` is the existing mirror ref used by `renameLane`; confirm its name with `grep -n "lanesRef" bpmn-canvas.tsx` and match it.)

- [ ] **Step 4: Wire the prop to LaneRail**

In the `<LaneRail ... />` JSX, add:
```tsx
        onSetColor={setLaneColor}
```

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean / succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/lane-rail.tsx src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(sp2): persisted lane color picker (swatches + custom), undoable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Frontend — persist lane collapse

> Gate: `npx tsc --noEmit` + `npm run build` + manual.

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx` (`collapsedLaneIds` init ~line 216; `toggleLaneCollapse` ~line 217-224)

- [ ] **Step 1: Seed collapse state from persisted lanes**

Change the `collapsedLaneIds` initializer to read `initialLanes`:
```ts
  const [collapsedLaneIds, setCollapsedLaneIds] = useState<Set<string>>(
    () => new Set(initialLanes.filter((l) => l.collapsed).map((l) => l.id))
  );
  const collapsedLaneIdsRef = useRef(collapsedLaneIds);
  collapsedLaneIdsRef.current = collapsedLaneIds;
```
(The `xRef.current = x` mirror idiom is already used throughout this file — this matches it. `initialLanes` carries `collapsed` after Task 3's `buildCanvasState` change.)

- [ ] **Step 2: Persist on toggle**

Replace `toggleLaneCollapse` with a version that computes the next value from the ref (avoiding a side effect inside the state updater) and persists via `markLane`:
```ts
  const toggleLaneCollapse = useCallback(
    (laneId: string) => {
      const willCollapse = !collapsedLaneIdsRef.current.has(laneId);
      setCollapsedLaneIds((curr) => {
        const next = new Set(curr);
        if (willCollapse) next.add(laneId);
        else next.delete(laneId);
        return next;
      });
      markLane(laneId, { collapsed: willCollapse });
    },
    [markLane]
  );
```
(Collapse stays out of the undo stack — pure view state, per spec.)

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean / succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(sp2): persist lane collapse state across reloads

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full verification

**Files:** none (verification only; fix-forward commits if issues found).

- [ ] **Step 1: Backend suite**

Run: `cd backend && .venv/bin/pytest tests/test_node_lane_editing.py -q`
Expected: all SP-2 backend tests pass. (Optionally run the full suite if quick.)

- [ ] **Step 2: Frontend gates**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: tsc clean (no new errors vs the documented baseline), Vitest green (incl. `node-type.test.ts`), build succeeds.

- [ ] **Step 3: Manual smoke via run-local**

Run: `./run-local.sh` (or confirm it's already up with `./run-local.sh status`). Open a process map with at least two lanes and a few nodes. Verify:
- **Type:** select a Task node → Properties → Type → choose "Exclusive gateway". The box reshapes to the small diamond **in place** (x/y unchanged). Press Ctrl+Z → reverts to Task. Reload the page → the change persisted (after the debounced save) / the revert persisted.
- **Type list:** the dropdown shows all 8 types with friendly labels and reflects the node's current type when re-selected.
- **Lane color:** open a lane's options menu → pick a palette swatch → the lane tint updates; pick the custom "+" picker → choose any color → updates live. Ctrl+Z reverts the color. Reload → color persisted.
- **Collapse:** collapse a lane via its chevron, reload the page → the lane is still collapsed. Expand it, reload → still expanded.
- **Provenance:** the Properties → Provenance section still lists the same claims/citations after a type change (links preserved).

- [ ] **Step 4: Record any deferred follow-ups**

If anything surfaced that's out of SP-2 scope, append a short "Deferred follow-ups" note to this plan (as SP-1 did) and commit it. Otherwise, no commit needed.

---

## Self-review notes (author)

- **Spec coverage:** Type editing (Tasks 1,3,4) ✓; lane color (Tasks 2,3,5) ✓; collapse persistence (Tasks 2,3,6) ✓; provenance preserved (Task 1 route leaves links + Task 1 test asserts) ✓; undo for type+color, none for collapse (Tasks 4,5,6) ✓; Vitest for the pure helper (Task 3) ✓.
- **Type consistency:** `NODE_TYPE_OPTIONS`/`sizeForNodeType` defined in Task 3, consumed in Tasks 4–5; `onSetColor` defined (LaneRail, Task 5 Step 1) and wired (Task 5 Step 4); `setLaneColor`/`setLaneColorLocal` names consistent; `collapsedLaneIdsRef` introduced in Task 6 and used only there.
- **Verify-against-source reminders:** the graph endpoint URL/JSON key (Task 2 Step 1 note), `lanesRef` name (Task 5 Step 3), and the exact existing `./layout` import line (Task 4 Step 3) are all flagged for the implementer to confirm by grep before editing.
