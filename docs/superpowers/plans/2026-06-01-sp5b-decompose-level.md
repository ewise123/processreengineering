# SP-5b — Decompose-to-next-level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth AI-edit action — **Decompose** — that proposes the finer sub-steps of a selected step (grounded in the node + neighbor claims) and, on Accept, materializes a child `ProcessModel` one level deeper with cross-level navigation (subprocess `+` marker → double-click in, breadcrumb out).

**Architecture:** Reuses the SP-5a forced-tool propose-then-apply framework end to end. The propose path adds a `propose_decompose` tool and a `decompose` branch to the existing `ai-edit` endpoint (with node+neighbor claim-ref hygiene and an L4 cap). A new apply endpoint creates-or-reuses the child model (`parent_model_id`, `level+1`), appends a `ProcessVersion`, persists the sub-step graph marked `ai_proposed`, and writes `child_model_id` onto the parent node's `properties` JSONB (no migration). Two small read endpoints (`GET .../{model_id}` and `GET .../{model_id}/ancestry`) feed the L4 cap, drill-in, and breadcrumb. Re-decompose appends a new child version; reversal soft-deletes the child model and clears the link.

**Tech Stack:** FastAPI + SQLAlchemy (backend, pytest); Next.js 16 / React 19 / TypeScript (frontend, Vitest node-env pure-logic tests + `tsc --noEmit`); Anthropic forced-tool pattern.

**Spec:** `docs/superpowers/specs/2026-06-01-sp5b-decompose-level-design.md`

**Conventions to honor (from SP-5a/SP-4):**
- Endpoint tests call the route functions directly with `project=…, db=…` kwargs (see `backend/tests/test_ai_edit.py`), not via an HTTP client.
- Service tests patch `map_ai_edit._get_client` with a fake returning a tool-use block.
- Frontend canvas components have **no** `.test.tsx` (Vitest is node-env, `include: src/**/*.test.ts`); verify them with `tsc --noEmit` + the live-smoke checklist. Pure logic gets real `.test.ts` tests.
- Binding gates: `cd backend && pytest`, `npx tsc --noEmit`, `npm test`. Lint is advisory.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Never push.

---

## File structure

**Backend**
- `backend/app/api/v2/process_maps.py` — add `_next_level`, `_neighbor_claim_ids`, `_resolve_refs_scoped`; the `decompose` branch in `ai_edit_node`; new endpoints `apply_decompose`, `remove_sub_process`, `get_process_map`, `get_map_ancestry`.
- `backend/app/services/map_ai_edit.py` — `DECOMPOSE_TOOL`, `_ACTION_INSTRUCTIONS["decompose"]`, `propose_decompose`.
- `backend/app/schemas/version_ai_edit.py` — `AiEditAction.DECOMPOSE`; `SubStep`, `DecomposeProposal`, `DecomposeRequest`, `DecomposeResult`; `AncestryCrumb`; `AiEditResponse.decompose`.
- `backend/tests/test_decompose.py` — all SP-5b backend tests (new file, keeps `test_ai_edit.py` focused).

**Frontend**
- `src/lib/types.ts` — `AiEditAction` union += `"decompose"`; `SubStep`, `DecomposeProposal`, `DecomposeRequest`, `DecomposeResult`, `AncestryCrumb`; `AiEditResponse.decompose`.
- `src/lib/api.ts` — `applyDecompose`, `removeSubProcess`, `getProcessMap`, `getMapAncestry`.
- `src/components/canvas/types.ts` — `CanvasNode.childModelId`; `CanvasSelection` node variant += `childModelId`.
- `src/components/canvas/layout.ts` — map `properties.child_model_id` → `CanvasNode.childModelId`.
- `src/components/canvas/shapes.tsx` — subprocess `+` marker.
- `src/components/canvas/bpmn-canvas.tsx` — `onDrillIntoNode` prop + `NodeShape` `onDoubleClick`; thread `childModelId` into the selection payload.
- `src/components/canvas/ai-edit-cache.tsx` — store `result.decompose` (no `pendingSteps`).
- `src/components/canvas/ai-edit-panel.tsx` — dynamic menu (decompose / open / re-decompose, L4 disable); decompose card; `onDecompose`, `onOpenChild` props.
- `src/components/canvas/decompose-nav.ts` — pure helpers: `buildBreadcrumb`, `hasChild` (new file, unit-tested).
- `src/components/canvas/decompose-nav.test.ts` — Vitest for the helpers.
- `src/components/canvas/properties-panel.tsx` — thread `level`, `childModelId`, `onDecompose`, `onOpenChild`, `onRemoveChild`; "Remove sub-process" control.
- `src/components/canvas/level-breadcrumb.tsx` — the breadcrumb component.
- `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — model + ancestry queries; breadcrumb; drill-in / decompose-accept / remove handlers; pass `level`/`childModelId`.

---

## Task 1: `_next_level` helper + L4 cap logic

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (near `_normalize_level`, line 102)
- Test: `backend/tests/test_decompose.py` (Create)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_decompose.py`:

```python
"""Tests for SP-5b decompose-to-next-level: helpers, service, endpoints."""
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import process_maps as pm_api
from app.enums import ClaimLinkKind
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process import (
    NodeClaimLink, ProcessEdge, ProcessLane, ProcessModel, ProcessNode, ProcessVersion,
)
from app.models.project import Project
from app.services import map_ai_edit


def test_next_level_increments_and_caps():
    assert pm_api._next_level("L1") == "L2"
    assert pm_api._next_level("L2") == "L3"
    assert pm_api._next_level("L3") == "L4"
    assert pm_api._next_level("L4") is None          # capped
    assert pm_api._next_level("3") == "L4"            # accepts bare digit
    assert pm_api._next_level("garbage") is None      # unparseable
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_decompose.py::test_next_level_increments_and_caps -v`
Expected: FAIL with `AttributeError: module 'app.api.v2.process_maps' has no attribute '_next_level'`.

- [ ] **Step 3: Implement `_next_level`**

In `backend/app/api/v2/process_maps.py`, immediately after `_level_for_prompt` (line ~112), add:

```python
def _next_level(level: str) -> str | None:
    """L1->L2 ... L3->L4. Returns None at the deepest level (L4) or when
    unparseable — the caller uses None to disable/422 decompose."""
    canon = _normalize_level(level)  # "L3"
    try:
        n = int(canon[1:])
    except (ValueError, IndexError):
        return None
    if n < 1 or n >= 4:
        return None
    return f"L{n + 1}"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && python -m pytest tests/test_decompose.py::test_next_level_increments_and_caps -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_decompose.py
git commit -m "$(cat <<'EOF'
feat(sp5b): _next_level helper with L4 cap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Neighbor claim-scope helpers

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (after `_resolve_refs`, line ~1169)
- Test: `backend/tests/test_decompose.py`

These compute the node+neighbor claim scope and a scoped variant of `_resolve_refs`. Decompose citations must survive only if they resolve to a claim attached to the selected node or a node one edge hop away.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_decompose.py`:

```python
def _seed_neighbors(db):
    """A linear graph n1 -> n2 -> n3, with claims c1@n1, c2@n2, c3@n3 and a
    detached claim c4 attached to no node. Returns (project, version, n2, ids)."""
    org = Organization(name="O"); db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U"); db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id); db.add(project); db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2"); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1); db.add(version); db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0); db.add(lane); db.flush()
    def node(name):
        n = ProcessNode(version_id=version.id, lane_id=lane.id, type="task", name=name,
                        position={}, properties={}); db.add(n); db.flush(); return n
    n1, n2, n3 = node("n1"), node("n2"), node("n3")
    db.add(ProcessEdge(version_id=version.id, source_node_id=n1.id, target_node_id=n2.id))
    db.add(ProcessEdge(version_id=version.id, source_node_id=n2.id, target_node_id=n3.id))
    claims = {}
    for key, owner in [("c1", n1), ("c2", n2), ("c3", n3), ("c4", None)]:
        c = Claim(project_id=project.id, kind="task", subject=key, normalized={})
        db.add(c); db.flush(); claims[key] = c
        if owner is not None:
            db.add(NodeClaimLink(node_id=owner.id, claim_id=c.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    return project, version, n2, claims


def test_neighbor_claim_ids_includes_self_and_one_hop(db):
    project, version, n2, claims = _seed_neighbors(db)
    scope = pm_api._neighbor_claim_ids(db, version.id, n2.id)
    # n2 plus its neighbors n1, n3 -> c1, c2, c3 in scope; c4 (detached) excluded.
    assert scope == {claims["c1"].id, claims["c2"].id, claims["c3"].id}


def test_resolve_refs_scoped_drops_out_of_scope(db):
    project, version, n2, claims = _seed_neighbors(db)
    scope = pm_api._neighbor_claim_ids(db, version.id, n2.id)
    ref_to_id = {"C1": claims["c2"].id, "C2": claims["c4"].id}  # C2 -> detached claim
    kept = pm_api._resolve_refs_scoped(["C1", "C2"], ref_to_id, scope)
    assert kept == [claims["c2"].id]  # C2 dropped: c4 not in node+neighbor scope
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "neighbor or scoped" -v`
Expected: FAIL — `_neighbor_claim_ids` / `_resolve_refs_scoped` not defined.

- [ ] **Step 3: Implement the helpers**

In `backend/app/api/v2/process_maps.py`, after `_resolve_refs` (line ~1169) add:

```python
def _neighbor_claim_ids(db: Session, version_id: UUID, node_id: UUID) -> set[UUID]:
    """Claim ids attached to the node plus every node one edge hop away — the
    grounding scope for decompose (tighter than project-wide)."""
    edge_rows = db.execute(
        select(ProcessEdge.source_node_id, ProcessEdge.target_node_id).where(
            ProcessEdge.version_id == version_id
        )
    ).all()
    node_ids: set[UUID] = {node_id}
    for src, tgt in edge_rows:
        if src == node_id:
            node_ids.add(tgt)
        if tgt == node_id:
            node_ids.add(src)
    claim_ids = db.scalars(
        select(NodeClaimLink.claim_id).where(NodeClaimLink.node_id.in_(node_ids))
    ).all()
    return set(claim_ids)


def _resolve_refs_scoped(refs, claim_ref_to_id, scope: set[UUID]):
    """Like _resolve_refs but additionally drops any resolved id not in `scope`."""
    return [cid for cid in _resolve_refs(refs, claim_ref_to_id) if cid in scope]
```

Confirm `ProcessEdge` and `NodeClaimLink` are already imported at the top of `process_maps.py` (they are — used by `apply_proposed_step`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "neighbor or scoped" -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_decompose.py
git commit -m "$(cat <<'EOF'
feat(sp5b): node+neighbor claim-scope helpers for decompose grounding

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Schemas

**Files:**
- Modify: `backend/app/schemas/version_ai_edit.py`
- Test: `backend/tests/test_decompose.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_decompose.py`:

```python
def test_decompose_schemas_roundtrip_and_validate():
    from app.schemas.version_ai_edit import (
        AiEditAction, AiEditResponse, DecomposeProposal, DecomposeRequest, SubStep,
    )
    assert AiEditAction("decompose") == AiEditAction.DECOMPOSE
    step = SubStep(proposed_name="Check budget", proposed_type="task", role="Finance",
                   edge_label="if > $10k", rationale="r", cited_claim_ids=[])
    proposal = DecomposeProposal(sub_steps=[step])
    resp = AiEditResponse(action=AiEditAction.DECOMPOSE, decompose=proposal)
    wire = resp.model_dump(by_alias=True)
    assert wire["action"] == "decompose"
    assert wire["decompose"]["sub_steps"][0]["role"] == "Finance"
    # apply request reuses SubStep
    req = DecomposeRequest(sub_steps=[step])
    assert req.sub_steps[0].proposed_type == "task"


def test_substep_rejects_unknown_type():
    from app.schemas.version_ai_edit import SubStep
    with pytest.raises(ValueError):
        SubStep(proposed_name="X", proposed_type="not_a_type", role="R", rationale="r")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "schemas or substep" -v`
Expected: FAIL — `AiEditAction` has no `DECOMPOSE` / no `SubStep`.

- [ ] **Step 3: Implement the schemas**

In `backend/app/schemas/version_ai_edit.py`:

Add `DECOMPOSE` to the enum:

```python
class AiEditAction(StrEnum):
    RELABEL = "relabel"
    DESCRIBE = "describe"
    VALIDATE = "validate"
    SUGGEST_NEXT = "suggest_next"
    DECOMPOSE = "decompose"
```

After `SuggestNextProposal` (line ~62) add:

```python
class SubStep(BaseModel):
    """One sub-step of a decomposed parent step. In a propose response,
    `cited_claim_ids` are the surviving (node+neighbor-scoped) claim UUIDs; in
    an apply request they are the user-accepted ids."""
    proposed_name: str = Field(min_length=1, max_length=500)
    proposed_type: str = Field(pattern=_NODE_TYPE_PATTERN)
    role: str = Field(min_length=1, max_length=300)
    edge_label: str | None = Field(default=None, max_length=300)
    rationale: str = Field(default="", max_length=2000)
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class DecomposeProposal(BaseModel):
    sub_steps: list[SubStep] = Field(default_factory=list)
```

In `AiEditResponse`, add the field (after `suggest_next`):

```python
    suggest_next: SuggestNextProposal | None = None
    decompose: DecomposeProposal | None = None
```

At the end of the file add the apply request/result and the breadcrumb crumb:

```python
class DecomposeRequest(BaseModel):
    """Apply a decompose proposal: create/append a child version from these
    accepted sub-steps."""
    sub_steps: list[SubStep] = Field(min_length=1)


class DecomposeResult(BaseModel):
    child_model_id: UUID
    child_version_id: UUID


class AncestryCrumb(BaseModel):
    model_id: UUID
    version_id: UUID | None
    level: str
    label: str
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "schemas or substep" -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/version_ai_edit.py backend/tests/test_decompose.py
git commit -m "$(cat <<'EOF'
feat(sp5b): decompose schemas (SubStep, proposal, request, result, ancestry)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `propose_decompose` service

**Files:**
- Modify: `backend/app/services/map_ai_edit.py`
- Test: `backend/tests/test_decompose.py`

- [ ] **Step 1: Write the failing test**

The existing `_FakeClient` lives in `backend/tests/test_ai_edit.py`. Re-declare a minimal one in `test_decompose.py` (DRY across test modules isn't worth a shared import here). Append:

```python
class _FakeToolClient:
    """Returns a single tool_use block with the given name + input."""
    def __init__(self, tool_name, payload):
        self._tool_name = tool_name
        self._payload = payload

    class _Messages:
        def __init__(self, outer): self._outer = outer
        def create(self, **kwargs):
            block = SimpleNamespace(type="tool_use", name=self._outer._tool_name,
                                    input=self._outer._payload)
            return SimpleNamespace(content=[block])

    @property
    def messages(self): return _FakeToolClient._Messages(self)


def test_propose_decompose_parses_sub_steps():
    fake = _FakeToolClient(
        "propose_decompose",
        {"sub_steps": [
            {"proposed_name": "Open ticket", "proposed_type": "task", "role": "Support",
             "edge_label": None, "rationale": "C1 mentions ticketing.", "cited_claim_refs": ["C1"]},
            {"proposed_name": "Triage", "proposed_type": "task", "role": "Support",
             "edge_label": "after open", "rationale": "C2.", "cited_claim_refs": ["C2"]},
        ]},
    )
    with patch.object(map_ai_edit, "_get_client", return_value=fake):
        out = map_ai_edit.propose_decompose(map_context_text="...", selected_label="N1")
    assert len(out["sub_steps"]) == 2
    assert out["sub_steps"][0]["role"] == "Support"
    assert out["sub_steps"][1]["cited_claim_refs"] == ["C2"]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_decompose.py::test_propose_decompose_parses_sub_steps -v`
Expected: FAIL — `map_ai_edit` has no `propose_decompose`.

- [ ] **Step 3: Implement the tool + service fn**

In `backend/app/services/map_ai_edit.py`, after `SUGGEST_TOOL` (line ~124) add:

```python
DECOMPOSE_TOOL = {
    "name": "propose_decompose",
    "description": (
        "Break the selected step into the finer sub-steps that compose it, grounded in the "
        "sources. Order them as they flow. Empty array if the sources don't support a breakdown."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "sub_steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "proposed_name": {"type": "string"},
                        "proposed_type": {"type": "string", "enum": _NODE_TYPES},
                        "role": {
                            "type": "string",
                            "description": "Actor/system performing this sub-step; becomes a child-map lane.",
                        },
                        "edge_label": {"type": ["string", "null"]},
                        "rationale": {"type": "string"},
                        "cited_claim_refs": _CITED,
                    },
                    "required": ["proposed_name", "proposed_type", "role", "rationale", "cited_claim_refs"],
                },
            }
        },
        "required": ["sub_steps"],
    },
}
```

Add the instruction to `_ACTION_INSTRUCTIONS` (after `"suggest_next"`):

```python
    "decompose": (
        "Focus on the currently selected step. Break it into the concrete sub-steps that "
        "compose it — the level of detail one tier finer. Order them as they flow and give "
        "each a role (the actor or system that performs it). Use only what the sources "
        "support; if they don't support a breakdown, return an empty array rather than inventing one."
    ),
```

Add the public fn after `propose_next_steps` (line ~198):

```python
def propose_decompose(*, map_context_text: str, selected_label: str | None) -> dict:
    return _run(DECOMPOSE_TOOL, "decompose", map_context_text, selected_label)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && python -m pytest tests/test_decompose.py::test_propose_decompose_parses_sub_steps -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_ai_edit.py backend/tests/test_decompose.py
git commit -m "$(cat <<'EOF'
feat(sp5b): propose_decompose forced-tool service fn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `decompose` branch in the propose endpoint

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (`ai_edit_node`, line ~1176; imports near line 62)
- Test: `backend/tests/test_decompose.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_decompose.py`:

```python
def test_propose_decompose_endpoint_filters_to_neighbor_scope(db):
    project, version, n2, claims = _seed_neighbors(db)
    # Model cites C2 (n2's own claim, in scope) and a project claim that is NOT
    # in the node+neighbor scope -> only the in-scope one survives.
    # Build the ref map from assemble_map_context so C-refs line up with claim order.
    from app.services.map_context import assemble_map_context
    ctx = assemble_map_context(db, version, selected_node_id=n2.id)
    # Find the C-ref for the in-scope claim c2 and the out-of-scope claim c4.
    id_to_ref = {v: k for k, v in ctx.claim_ref_to_id.items()}
    in_ref = id_to_ref[claims["c2"].id]
    out_ref = id_to_ref[claims["c4"].id]
    fake = {"sub_steps": [
        {"proposed_name": "Sub A", "proposed_type": "task", "role": "Ops",
         "edge_label": None, "rationale": "r", "cited_claim_refs": [in_ref, out_ref]},
    ]}
    with patch.object(pm_api, "propose_decompose", return_value=fake):
        resp = pm_api.ai_edit_node(
            project=project, model_id=version.model_id, version_id=version.id,
            node_id=n2.id, payload=pm_api.AiEditRequest(action="decompose"), db=db,
        )
    step = resp.decompose.sub_steps[0]
    assert step.cited_claim_ids == [claims["c2"].id]  # out-of-scope c4 dropped


def test_propose_decompose_endpoint_422_at_l4(db):
    project, version, n2, claims = _seed_neighbors(db)
    model = db.get(ProcessModel, version.model_id)
    model.level = "L4"; db.commit()
    with patch.object(pm_api, "propose_decompose", return_value={"sub_steps": []}):
        with pytest.raises(HTTPException) as exc:
            pm_api.ai_edit_node(
                project=project, model_id=version.model_id, version_id=version.id,
                node_id=n2.id, payload=pm_api.AiEditRequest(action="decompose"), db=db,
            )
    assert exc.value.status_code == 422
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "propose_decompose_endpoint" -v`
Expected: FAIL — the endpoint raises 422 "Unsupported action: decompose" (its current fallthrough), so the first test fails on the missing branch and the second fails because the 422 is the wrong-reason fallback (it would still pass status 422 by accident, so assert message). Adjust the L4 test to also assert the detail mentions the level:

Add to the L4 test: `assert "level" in exc.value.detail.lower() or "L4" in exc.value.detail`.

- [ ] **Step 3: Implement the branch**

First extend the imports. In `process_maps.py` near line 62 (the `version_ai_edit` import block) add the new names:

```python
from app.schemas.version_ai_edit import (
    AiEditAction,
    AiEditRequest,
    AiProposedStepRequest,
    AncestryCrumb,
    DecomposeProposal,
    DecomposeRequest,
    DecomposeResult,
    SubStep,
)
```
(Keep the names already imported there; add the four new ones. Confirm the existing block — `AiEditResponse`, `RelabelProposal`, etc. — remains.)

Add the service import next to `propose_next_steps` (search for the existing `from app.services.map_ai_edit import` block and add `propose_decompose`):

```python
from app.services.map_ai_edit import (
    propose_description,
    propose_decompose,
    propose_next_steps,
    propose_relabel,
    report_gaps,
)
```

In `ai_edit_node`, insert the decompose branch immediately before the final `raise HTTPException(status_code=422, detail=f"Unsupported action: {payload.action}")` (line ~1246):

```python
        if payload.action == AiEditAction.DECOMPOSE:
            if _next_level(model.level) is None:
                raise HTTPException(
                    status_code=422,
                    detail="Cannot decompose: already at the most detailed level (L4).",
                )
            scope = _neighbor_claim_ids(db, version.id, node.id)
            raw = propose_decompose(map_context_text=ctx.text, selected_label=ctx.selected_label)
            steps = [
                SubStep(
                    proposed_name=s.get("proposed_name", ""),
                    proposed_type=s.get("proposed_type", "task"),
                    role=s.get("role", "Process Team"),
                    edge_label=s.get("edge_label"),
                    rationale=s.get("rationale", ""),
                    cited_claim_ids=_resolve_refs_scoped(
                        s.get("cited_claim_refs"), ctx.claim_ref_to_id, scope
                    ),
                )
                for s in raw.get("sub_steps", [])
                if s.get("proposed_name")
            ]
            return AiEditResponse(action=payload.action, decompose=DecomposeProposal(sub_steps=steps))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "propose_decompose_endpoint" -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_decompose.py
git commit -m "$(cat <<'EOF'
feat(sp5b): decompose branch in ai-edit endpoint (neighbor hygiene + L4 422)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Apply-decompose endpoint

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (after `apply_proposed_step`, line ~1336)
- Test: `backend/tests/test_decompose.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_decompose.py`:

```python
def _decompose_payload(claim_id=None):
    from app.schemas.version_ai_edit import DecomposeRequest, SubStep
    cited = [claim_id] if claim_id else []
    return DecomposeRequest(sub_steps=[
        SubStep(proposed_name="Open ticket", proposed_type="task", role="Support",
                edge_label=None, rationale="r", cited_claim_ids=cited),
        SubStep(proposed_name="Triage", proposed_type="task", role="Triage Team",
                edge_label="after open", rationale="r", cited_claim_ids=[]),
    ])


def test_apply_decompose_creates_child_model_version_and_links(db):
    project, version, n2, claims = _seed_neighbors(db)
    result = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(claims["c2"].id), db=db,
    )
    child = db.get(ProcessModel, result.child_model_id)
    assert child.parent_model_id == version.model_id
    assert child.level == "L3"                       # parent L2 -> L3
    assert child.name == "n2"                          # parent step label
    cv = db.get(ProcessVersion, result.child_version_id)
    assert cv.model_id == child.id and cv.version_number == 1
    # two ai_proposed nodes, two lanes (distinct roles), one edge, one claim link
    nodes = list(db.scalars(select(ProcessNode).where(ProcessNode.version_id == cv.id)).all())
    assert len(nodes) == 2 and all(n.properties["ai_proposed"] is True for n in nodes)
    assert all(n.properties["_lineage_id"] == str(n.id) for n in nodes)
    lanes = list(db.scalars(select(ProcessLane).where(ProcessLane.version_id == cv.id)).all())
    assert len(lanes) == 2
    edges = list(db.scalars(select(ProcessEdge).where(ProcessEdge.version_id == cv.id)).all())
    assert len(edges) == 1
    links = list(db.scalars(select(NodeClaimLink).where(NodeClaimLink.node_id.in_([n.id for n in nodes]))).all())
    assert len(links) == 1 and links[0].link_kind == "ai_proposed"
    # parent node now points at the child model
    db.refresh(n2)
    assert n2.properties["child_model_id"] == str(child.id)


def test_re_decompose_appends_new_child_version(db):
    project, version, n2, claims = _seed_neighbors(db)
    first = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(), db=db,
    )
    second = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(), db=db,
    )
    assert first.child_model_id == second.child_model_id    # same child model
    v1 = db.get(ProcessVersion, first.child_version_id)
    v2 = db.get(ProcessVersion, second.child_version_id)
    assert v2.version_number == 2 and v2.parent_version_id == v1.id


def test_apply_decompose_ignores_foreign_claim_ids(db):
    project, version, n2, claims = _seed_neighbors(db)
    result = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(uuid4()), db=db,  # bogus claim id
    )
    cv = db.get(ProcessVersion, result.child_version_id)
    nodes = list(db.scalars(select(ProcessNode).where(ProcessNode.version_id == cv.id)).all())
    links = list(db.scalars(select(NodeClaimLink).where(NodeClaimLink.node_id.in_([n.id for n in nodes]))).all())
    assert links == []   # foreign id silently dropped


def test_apply_decompose_422_at_l4(db):
    project, version, n2, claims = _seed_neighbors(db)
    model = db.get(ProcessModel, version.model_id); model.level = "L4"; db.commit()
    with pytest.raises(HTTPException) as exc:
        pm_api.apply_decompose(
            project=project, model_id=version.model_id, version_id=version.id,
            node_id=n2.id, payload=_decompose_payload(), db=db,
        )
    assert exc.value.status_code == 422
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "apply_decompose or re_decompose" -v`
Expected: FAIL — `apply_decompose` not defined.

- [ ] **Step 3: Implement the endpoint**

In `process_maps.py`, after `apply_proposed_step` (ends line ~1336) add. Confirm `func`, `flag_modified`, `LINEAGE_KEY`, `ProcessVersionStatus`, `Claim`, `ClaimLinkKind` are imported (all already used in this file):

```python
@router.post(
    "/process-maps/{model_id}/versions/{version_id}/nodes/{node_id}/decompose",
    response_model=DecomposeResult,
    status_code=status.HTTP_201_CREATED,
)
def apply_decompose(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    node_id: UUID,
    payload: DecomposeRequest,
    db: Annotated[Session, Depends(get_db)],
) -> DecomposeResult:
    """Accept a decompose proposal: create-or-reuse a child ProcessModel one
    level deeper, append a ProcessVersion, persist the sub-step graph marked
    ai_proposed, and link the parent node via properties.child_model_id. One
    transaction; foreign claim ids are silently dropped."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    node = db.get(ProcessNode, node_id)
    if node is None or node.version_id != version.id:
        raise HTTPException(status_code=404, detail="Node not found in this version")

    child_level = _next_level(model.level)
    if child_level is None:
        raise HTTPException(
            status_code=422,
            detail="Cannot decompose: already at the most detailed level (L4).",
        )

    # Find-or-create the child model via the parent node's stored link.
    existing_id = (node.properties or {}).get("child_model_id")
    child: ProcessModel | None = None
    if existing_id:
        candidate = db.get(ProcessModel, UUID(existing_id))
        if candidate is not None and candidate.deleted_at is None and candidate.project_id == project.id:
            child = candidate
    if child is None:
        child = ProcessModel(
            project_id=project.id,
            name=node.name[:300],
            level=child_level,
            parent_model_id=model.id,
        )
        db.add(child)
        db.flush()

    # Append a new version (re-decompose chains onto the prior latest).
    last_num = db.scalar(
        select(func.coalesce(func.max(ProcessVersion.version_number), 0)).where(
            ProcessVersion.model_id == child.id
        )
    ) or 0
    parent_version = db.scalars(
        select(ProcessVersion)
        .where(ProcessVersion.model_id == child.id, ProcessVersion.version_number == last_num)
        .limit(1)
    ).first()
    child_version = ProcessVersion(
        model_id=child.id,
        version_number=last_num + 1,
        parent_version_id=parent_version.id if parent_version else None,
        status=ProcessVersionStatus.DRAFT.value,
        notes=f"AI-decomposed from '{node.name}'.",
    )
    db.add(child_version)
    db.flush()

    # Lanes: one per distinct role, document order.
    role_order: list[str] = []
    seen: set[str] = set()
    for s in payload.sub_steps:
        r = (s.role or "Process Team").strip() or "Process Team"
        if r not in seen:
            role_order.append(r)
            seen.add(r)
    lane_by_role: dict[str, ProcessLane] = {}
    for idx, role in enumerate(role_order):
        lane = ProcessLane(version_id=child_version.id, name=role, order_index=idx)
        db.add(lane)
        lane_by_role[role] = lane
    db.flush()

    # Resolve real cited claims once (project-scoped guard).
    all_cited = [cid for s in payload.sub_steps for cid in s.cited_claim_ids]
    real_claim_ids: set[UUID] = set()
    if all_cited:
        real_claim_ids = set(
            db.scalars(
                select(Claim.id).where(Claim.id.in_(all_cited), Claim.project_id == project.id)
            ).all()
        )

    # Nodes + linear edge chain. Leave position empty -> the canvas lays it out
    # with Dagre on first open.
    prev: ProcessNode | None = None
    for s in payload.sub_steps:
        role = (s.role or "Process Team").strip() or "Process Team"
        new_node = ProcessNode(
            version_id=child_version.id,
            type=s.proposed_type,
            name=s.proposed_name,
            lane_id=lane_by_role[role].id,
            position={},
            properties={},
        )
        db.add(new_node)
        db.flush()
        new_node.properties = {LINEAGE_KEY: str(new_node.id), "ai_proposed": True}
        flag_modified(new_node, "properties")
        seen_link: set[UUID] = set()
        for cid in s.cited_claim_ids:
            if cid in real_claim_ids and cid not in seen_link:
                db.add(NodeClaimLink(node_id=new_node.id, claim_id=cid,
                                     link_kind=ClaimLinkKind.AI_PROPOSED.value))
                seen_link.add(cid)
        if prev is not None:
            db.add(ProcessEdge(
                version_id=child_version.id,
                source_node_id=prev.id,
                target_node_id=new_node.id,
                label=s.edge_label or None,
            ))
        prev = new_node

    # Link the parent node to the child model.
    node.properties = {**(node.properties or {}), "child_model_id": str(child.id)}
    flag_modified(node, "properties")

    db.commit()
    return DecomposeResult(child_model_id=child.id, child_version_id=child_version.id)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "apply_decompose or re_decompose" -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_decompose.py
git commit -m "$(cat <<'EOF'
feat(sp5b): apply-decompose endpoint (child model + version + graph)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Remove-sub-process endpoint

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (after `apply_decompose`)
- Test: `backend/tests/test_decompose.py`

- [ ] **Step 1: Write the failing test**

Append:

```python
def test_remove_sub_process_soft_deletes_child_and_clears_link(db):
    project, version, n2, claims = _seed_neighbors(db)
    result = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(), db=db,
    )
    child_id = result.child_model_id
    pm_api.remove_sub_process(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, db=db,
    )
    db.refresh(n2)
    assert "child_model_id" not in n2.properties
    child = db.get(ProcessModel, child_id)
    assert child.deleted_at is not None   # soft-deleted (drops out of the maps list)


def test_remove_sub_process_404_when_no_child(db):
    project, version, n2, claims = _seed_neighbors(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.remove_sub_process(
            project=project, model_id=version.model_id, version_id=version.id,
            node_id=n2.id, db=db,
        )
    assert exc.value.status_code == 404
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "remove_sub_process" -v`
Expected: FAIL — `remove_sub_process` not defined.

- [ ] **Step 3: Implement**

Confirm `datetime` is available. `SoftDeleteMixin` provides `deleted_at`; set it directly. Check the mixin's column name (it is `deleted_at`, used by the list query). Add after `apply_decompose`:

```python
@router.delete(
    "/process-maps/{model_id}/versions/{version_id}/nodes/{node_id}/decompose",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_sub_process(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    node_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    """Reverse a decompose: soft-delete the child model (it leaves the maps
    list) and clear the parent node's child_model_id link."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    node = db.get(ProcessNode, node_id)
    if node is None or node.version_id != version.id:
        raise HTTPException(status_code=404, detail="Node not found in this version")

    child_id = (node.properties or {}).get("child_model_id")
    if not child_id:
        raise HTTPException(status_code=404, detail="Step has no sub-process to remove")

    child = db.get(ProcessModel, UUID(child_id))
    if child is not None and child.deleted_at is None and child.project_id == project.id:
        from datetime import datetime, timezone
        child.deleted_at = datetime.now(timezone.utc)

    props = {**(node.properties or {})}
    props.pop("child_model_id", None)
    node.properties = props
    flag_modified(node, "properties")
    db.commit()
```

If `SoftDeleteMixin.deleted_at` is timezone-naive in this codebase, use `datetime.utcnow()` instead — check `backend/app/db/mixins.py` and match its convention. (Verify during implementation; the list query only checks `deleted_at.is_(None)`, so either works.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "remove_sub_process" -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_decompose.py
git commit -m "$(cat <<'EOF'
feat(sp5b): remove-sub-process endpoint (soft-delete child, clear link)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Get-model + ancestry endpoints

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (after `list_process_maps`, line ~466)
- Test: `backend/tests/test_decompose.py`

- [ ] **Step 1: Write the failing tests**

Append:

```python
def test_get_process_map_returns_level_and_latest_version(db):
    project, version, n2, claims = _seed_neighbors(db)
    out = pm_api.get_process_map(project=project, model_id=version.model_id, db=db)
    assert out.level == "L2"
    assert out.latest_version_id == version.id
    assert out.latest_version_number == 1


def test_ancestry_returns_root_to_leaf_chain(db):
    project, version, n2, claims = _seed_neighbors(db)
    # Decompose n2 -> child (L3); then decompose a node in the child -> grandchild (L4).
    res = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(), db=db,
    )
    cv = db.get(ProcessVersion, res.child_version_id)
    child_node = db.scalars(select(ProcessNode).where(ProcessNode.version_id == cv.id)).first()
    res2 = pm_api.apply_decompose(
        project=project, model_id=res.child_model_id, version_id=cv.id,
        node_id=child_node.id, payload=_decompose_payload(), db=db,
    )
    chain = pm_api.get_map_ancestry(project=project, model_id=res2.child_model_id, db=db)
    levels = [c.level for c in chain]
    assert levels == ["L2", "L3", "L4"]                  # root first
    assert chain[0].model_id == version.model_id
    assert chain[-1].model_id == res2.child_model_id
    # crumb label for the L3 map is the parent step it was decomposed from ("n2")
    assert chain[1].label == "n2"


def test_ancestry_single_for_root_map(db):
    project, version, n2, claims = _seed_neighbors(db)
    chain = pm_api.get_map_ancestry(project=project, model_id=version.model_id, db=db)
    assert len(chain) == 1 and chain[0].model_id == version.model_id
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "get_process_map or ancestry" -v`
Expected: FAIL — `get_process_map` / `get_map_ancestry` not defined.

- [ ] **Step 3: Implement both endpoints**

Confirm `ProcessModelRead` is imported (it is, line 57). Add after `list_process_maps` (line ~466):

```python
def _latest_version_row(db: Session, model_id: UUID):
    """(version_id, version_number) of a model's highest version, or (None, None)."""
    row = db.execute(
        select(ProcessVersion.id, ProcessVersion.version_number)
        .where(ProcessVersion.model_id == model_id)
        .order_by(ProcessVersion.version_number.desc())
        .limit(1)
    ).first()
    return (row[0], row[1]) if row else (None, None)


@router.get("/process-maps/{model_id}", response_model=ProcessModelRead)
def get_process_map(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessModelRead:
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id or model.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Process model not found")
    lv_id, lv_num = _latest_version_row(db, model.id)
    return ProcessModelRead.model_validate(model).model_copy(
        update={"latest_version_id": lv_id, "latest_version_number": lv_num}
    )


@router.get("/process-maps/{model_id}/ancestry", response_model=list[AncestryCrumb])
def get_map_ancestry(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> list[AncestryCrumb]:
    """Root-to-leaf chain of maps for the breadcrumb. Each crumb's label is the
    parent step it was decomposed from (resolved live via the reverse lookup),
    falling back to the model's own name; deep-link = that map's latest version."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")

    # Walk up to the root (guard against cycles).
    chain: list[ProcessModel] = []
    cur: ProcessModel | None = model
    guard = 0
    while cur is not None and guard < 16:
        chain.append(cur)
        guard += 1
        cur = db.get(ProcessModel, cur.parent_model_id) if cur.parent_model_id else None
    chain.reverse()  # root first

    crumbs: list[AncestryCrumb] = []
    for i, m in enumerate(chain):
        lv_id, _ = _latest_version_row(db, m.id)
        label = m.name
        # For non-root maps, prefer the live name of the parent step that points here.
        if i > 0:
            parent = chain[i - 1]
            p_lv_id, _ = _latest_version_row(db, parent.id)
            if p_lv_id is not None:
                p_nodes = db.scalars(
                    select(ProcessNode).where(ProcessNode.version_id == p_lv_id)
                ).all()
                for n in p_nodes:
                    if (n.properties or {}).get("child_model_id") == str(m.id):
                        label = n.name
                        break
        crumbs.append(AncestryCrumb(model_id=m.id, version_id=lv_id, level=m.level, label=label))
    return crumbs
```

Note the route-ordering: `GET /process-maps/{model_id}` is declared after `GET /process-maps` (the list) and before the version routes; FastAPI matches a single path segment, so it does not shadow `/process-maps/{model_id}/versions/...`. Verify with the OpenAPI check in Step 4.

- [ ] **Step 4: Run the tests + a route smoke**

Run: `cd backend && python -m pytest tests/test_decompose.py -k "get_process_map or ancestry" -v`
Expected: PASS (3 tests).

Run: `cd backend && python -c "from app.main import app; print('ok')"`
Expected: prints `ok` (app imports — no route registration error).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_decompose.py
git commit -m "$(cat <<'EOF'
feat(sp5b): get-model + ancestry endpoints (level, drill-in, breadcrumb)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Full backend suite green

**Files:** none (verification)

- [ ] **Step 1: Run the whole backend suite**

Run: `cd backend && python -m pytest -q`
Expected: all pass (the SP-5a `test_ai_edit.py` suite still green + the new `test_decompose.py`). If a migration-dependent test errors about a missing column, none is expected here (SP-5b adds no columns); investigate before continuing.

- [ ] **Step 2: Commit (only if any fixups were needed)**

```bash
git add -A && git commit -m "$(cat <<'EOF'
test(sp5b): backend suite green after decompose endpoints

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Frontend types + API client

**Files:**
- Modify: `src/lib/types.ts` (AI-edit section, line ~451)
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Extend the types**

In `src/lib/types.ts`, change the action union (line 451):

```typescript
export type AiEditAction = "relabel" | "describe" | "validate" | "suggest_next" | "decompose";
```

After `SuggestNextProposal` (line ~486) add:

```typescript
export interface SubStep {
  proposed_name: string;
  proposed_type: string;
  role: string;
  edge_label: string | null;
  rationale: string;
  cited_claim_ids: UUID[];
}

export interface DecomposeProposal {
  sub_steps: SubStep[];
}

export interface DecomposeRequest {
  sub_steps: SubStep[];
}

export interface DecomposeResult {
  child_model_id: UUID;
  child_version_id: UUID;
}

export interface AncestryCrumb {
  model_id: UUID;
  version_id: UUID | null;
  level: string;
  label: string;
}
```

In `AiEditResponse` (line ~488) add the field:

```typescript
export interface AiEditResponse {
  action: AiEditAction;
  relabel?: RelabelProposal | null;
  describe?: DescribeProposal | null;
  validate?: ValidateProposal | null;
  suggest_next?: SuggestNextProposal | null;
  decompose?: DecomposeProposal | null;
}
```

- [ ] **Step 2: Extend the API client**

In `src/lib/api.ts`, ensure the import block (line ~3) includes the new types, then add fns after `applyProposedStep` (line ~324):

```typescript
  applyDecompose: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    nodeId: UUID,
    body: DecomposeRequest
  ) =>
    request<DecomposeResult>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/nodes/${nodeId}/decompose`,
      { method: "POST", json: body }
    ),
  removeSubProcess: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    nodeId: UUID
  ) =>
    request<void>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/nodes/${nodeId}/decompose`,
      { method: "DELETE" }
    ),
  getProcessMap: (projectId: UUID, modelId: UUID) =>
    request<ProcessModel>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}`
    ),
  getMapAncestry: (projectId: UUID, modelId: UUID) =>
    request<AncestryCrumb[]>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/ancestry`
    ),
```

Add to the import block at the top of `api.ts` (the `import type { … } from "./types"`): `AncestryCrumb, DecomposeRequest, DecomposeResult, ProcessModel` (confirm `ProcessModel` type exists in `types.ts`; it is the return type of `listProcessMaps` — reuse the same type used there).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `request<void>` complains about DELETE with 204, mirror how other `DELETE` calls in `api.ts` are typed — e.g. `deleteNode` — and match that signature exactly.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "$(cat <<'EOF'
feat(sp5b): frontend decompose types + api client fns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `CanvasNode.childModelId` + layout + selection threading

**Files:**
- Modify: `src/components/canvas/types.ts`
- Modify: `src/components/canvas/layout.ts` (line ~130)
- Modify: `src/components/canvas/bpmn-canvas.tsx` (selection emission, line ~748; addProposedStep node build, line ~400)

- [ ] **Step 1: Add the field to `CanvasNode` and `CanvasSelection`**

In `src/components/canvas/types.ts`, in `CanvasNode` after `description?` (line ~40):

```typescript
  /** Optional free-text description (properties.description). */
  description?: string;
  /** Child ProcessModel id when this step has been decomposed
   * (properties.child_model_id). Drives the subprocess "+" marker and drill-in. */
  childModelId?: UUID | null;
```

- [ ] **Step 2: Map it in `buildCanvasState`**

In `src/components/canvas/layout.ts`, in the node mapping object (after the `description:` line, ~131):

```typescript
      aiProposed: (n.properties as { ai_proposed?: boolean } | null)?.ai_proposed === true,
      description: (n.properties as { description?: string } | null)?.description,
      childModelId: (n.properties as { child_model_id?: string } | null)?.child_model_id ?? null,
```

- [ ] **Step 3: Add `childModelId` to the selection node variant**

In `src/components/canvas/bpmn-canvas.tsx`, `CanvasSelection` (line 132):

```typescript
  | { kind: "node"; id: UUID; name?: string; nodeKind?: string; type?: string; laneId?: UUID | null; description?: string; childModelId?: UUID | null }
```

In the selection-emission effect (line ~748), add `childModelId`:

```typescript
        onSelectionChange({
          kind: "node",
          id,
          name: node.label,
          nodeKind: node.kind,
          type: node.type,
          laneId: node.laneId,
          description: node.description,
          childModelId: node.childModelId ?? null,
        });
```

(Newly-added AI-proposed nodes in `addProposedStep` have no child, so no change is needed there — `childModelId` defaults to `undefined`/`null`.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/types.ts src/components/canvas/layout.ts src/components/canvas/bpmn-canvas.tsx
git commit -m "$(cat <<'EOF'
feat(sp5b): thread childModelId through CanvasNode + selection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Subprocess `+` marker in `shapes.tsx`

**Files:**
- Modify: `src/components/canvas/shapes.tsx` (the `isTask` block, line ~263)

The marker is a small bottom-center box with a `+`, the BPMN collapsed-subprocess convention. Render it only for task-kind shapes (decompose targets steps; events/gateways are not decomposable in practice).

- [ ] **Step 1: Add the marker**

In `src/components/canvas/shapes.tsx`, inside the `isTask` block, after the proposed `✦` text and before the `<foreignObject>` label (line ~279), add:

```tsx
          {node.childModelId && (
            <g transform={`translate(${w / 2 - 7}, ${h - 14})`} aria-label="Has sub-process" style={{ pointerEvents: "none" }}>
              <rect width={14} height={12} rx={2} fill="#fff" stroke="#475569" strokeWidth={1} />
              <line x1={7} y1={3} x2={7} y2={9} stroke="#475569" strokeWidth={1.2} />
              <line x1={4} y1={6} x2={10} y2={6} stroke="#475569" strokeWidth={1.2} />
            </g>
          )}
```

`ResolvedNode` already carries `childModelId` because it is `Omit<CanvasNode, "relativeY"> & { y }`. No type change needed.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/canvas/shapes.tsx
git commit -m "$(cat <<'EOF'
feat(sp5b): subprocess "+" marker on decomposed steps

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Double-click drill-in plumbing

**Files:**
- Modify: `src/components/canvas/shapes.tsx` (`NodeShape` props + root `<g>`)
- Modify: `src/components/canvas/bpmn-canvas.tsx` (`BpmnCanvasProps`, `NodeShape` render, line ~1895)

Nodes have no existing double-click behavior (label editing is in the Properties panel), so a node double-click is free for drill-in.

- [ ] **Step 1: Add `onDoubleClick` to `NodeShape`**

In `src/components/canvas/shapes.tsx`, add to the `NodeShape` props destructure + type (line ~157-176):

```tsx
  onContextMenu,
  onStartConnect,
  onDoubleClick,
}: {
  // …existing props…
  onContextMenu?: (e: MouseEvent, id: string) => void;
  onStartConnect?: (e: MouseEvent, sourceId: UUID, side: ConnectSide) => void;
  onDoubleClick?: (id: string) => void;
}) {
```

On the root `<g>` (line ~199), add the handler:

```tsx
    <g
      transform={`translate(${x},${y})`}
      style={{ cursor: showHandles ? "crosshair" : "move" }}
      onMouseDown={(e) => onMouseDown(e, id)}
      onContextMenu={(e) => onContextMenu?.(e, id)}
      onDoubleClick={() => onDoubleClick?.(id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-node-id={id}
    >
```

- [ ] **Step 2: Add the canvas prop + wire it**

In `src/components/canvas/bpmn-canvas.tsx`, add to `BpmnCanvasProps` (after `onCountsChange`, line ~180):

```typescript
  /** Fires when a node with a child sub-process is double-clicked. The page
   * resolves the child's latest version and routes there. */
  onDrillIntoNode?: (childModelId: UUID) => void;
```

Add `onDrillIntoNode` to the destructured props (near `onCountsChange`, line ~195 area — match the existing destructure list).

In the `NodeShape` render (line ~1895), add the handler:

```tsx
          {renderNodes.map((node) => (
            <NodeShape
              key={node.id}
              node={node}
              selected={selectedIds.has(node.id)}
              issueLevel={showIssues ? issuesMap[node.id] ?? null : null}
              reviewBadge={reviewMode ? reviewMap[node.id] ?? null : null}
              showHandles={tool === "connect"}
              onMouseDown={onNodeMouseDown}
              onContextMenu={openNodeMenu}
              onStartConnect={onStartConnect}
              onDoubleClick={(id) => {
                const n = nodesRef.current.find((x) => x.id === id);
                if (n?.childModelId) onDrillIntoNode?.(n.childModelId);
              }}
            />
          ))}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/shapes.tsx src/components/canvas/bpmn-canvas.tsx
git commit -m "$(cat <<'EOF'
feat(sp5b): double-click a decomposed step to drill into its child map

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Decompose navigation helpers (pure, unit-tested)

**Files:**
- Create: `src/components/canvas/decompose-nav.ts`
- Create: `src/components/canvas/decompose-nav.test.ts`

These are the pure logic pieces the breadcrumb and panel rely on — testable in the node-env Vitest setup.

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/decompose-nav.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { buildBreadcrumb, canDecompose } from "./decompose-nav";
import type { AncestryCrumb } from "@/lib/types";

const crumbs: AncestryCrumb[] = [
  { model_id: "m1", version_id: "v1", level: "L2", label: "Order to cash" },
  { model_id: "m2", version_id: "v2", level: "L3", label: "Approve invoice" },
  { model_id: "m3", version_id: null, level: "L4", label: "Verify totals" },
];

describe("buildBreadcrumb", () => {
  it("marks the last crumb current and the rest navigable with hrefs", () => {
    const out = buildBreadcrumb(crumbs, "proj");
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      label: "Order to cash",
      current: false,
      href: "/projects/proj/maps/m1/versions/v1",
    });
    expect(out[2]).toMatchObject({ label: "Verify totals", current: true });
    // a crumb with no latest version is not navigable
    expect(out[2].href).toBeNull();
  });

  it("returns an empty array for a single-element (root) chain", () => {
    expect(buildBreadcrumb([crumbs[0]], "proj")).toEqual([]);
  });
});

describe("canDecompose", () => {
  it("is true below L4 and false at L4", () => {
    expect(canDecompose("L1")).toBe(true);
    expect(canDecompose("L3")).toBe(true);
    expect(canDecompose("L4")).toBe(false);
    expect(canDecompose(null)).toBe(false);   // unknown level -> safe default
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- decompose-nav`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `src/components/canvas/decompose-nav.ts`:

```typescript
import type { AncestryCrumb, UUID } from "@/lib/types";

export interface BreadcrumbItem {
  modelId: UUID;
  label: string;
  level: string;
  current: boolean;
  /** Navigation target, or null when the map has no version to open. */
  href: string | null;
}

/**
 * Map an ancestry chain (root -> leaf) into renderable breadcrumb items.
 * Returns [] for a root map (a single-element chain) so single-level maps
 * render no breadcrumb. The last crumb is the current map.
 */
export function buildBreadcrumb(crumbs: AncestryCrumb[], projectId: UUID): BreadcrumbItem[] {
  if (crumbs.length <= 1) return [];
  return crumbs.map((c, i) => ({
    modelId: c.model_id,
    label: c.label,
    level: c.level,
    current: i === crumbs.length - 1,
    href: c.version_id ? `/projects/${projectId}/maps/${c.model_id}/versions/${c.version_id}` : null,
  }));
}

/** Decompose is offered only below the deepest level (L4). */
export function canDecompose(level: string | null | undefined): boolean {
  if (!level) return false;
  const n = parseInt(level.replace(/^L/i, ""), 10);
  return Number.isFinite(n) && n >= 1 && n < 4;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- decompose-nav`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/decompose-nav.ts src/components/canvas/decompose-nav.test.ts
git commit -m "$(cat <<'EOF'
feat(sp5b): pure breadcrumb + canDecompose helpers with tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: AI-edit cache + panel — decompose action

**Files:**
- Modify: `src/components/canvas/ai-edit-cache.tsx`
- Modify: `src/components/canvas/ai-edit-panel.tsx`

- [ ] **Step 1: Cache — populate from `result.decompose`**

In `src/components/canvas/ai-edit-cache.tsx`, the `runAction` success branch (line ~63) already stores `result`. Decompose needs no `pendingSteps` (single-accept card). No change is required to store the result — `entry.result.decompose` is available. Add a clarifying comment above the `patch` call in the success branch:

```typescript
        // suggest_next manages per-card removal via pendingSteps; decompose is a
        // single-accept card read straight off result.decompose (no pendingSteps).
        patch(nodeId, {
          loading: false,
          loadingAction: null,
          result: res,
          pendingSteps: res.suggest_next ? res.suggest_next.steps : null,
        });
```

- [ ] **Step 2: Panel — add the decompose action, menu logic, and card**

In `src/components/canvas/ai-edit-panel.tsx`:

Add the loading label (line ~14):

```typescript
const LOADING_LABELS: Record<AiEditAction, string> = {
  relabel: "Relabeling step…",
  describe: "Writing description…",
  validate: "Checking for gaps…",
  suggest_next: "Suggesting next steps…",
  decompose: "Decomposing into sub-steps…",
};
```

Replace the static `ACTIONS` array with a function that depends on the node's state. Remove the const `ACTIONS` (lines 21-26) and instead build the menu inside the component. Update the component signature + body:

```tsx
import { canDecompose } from "@/components/canvas/decompose-nav";
import type {
  AiEditAction,
  AiEditResponse,
  SubStep,
  SuggestedStep,
  UUID,
} from "@/lib/types";

// …LOADING_LABELS…

export function AiEditPanel({
  projectId,
  modelId,
  versionId,
  nodeId,
  level,
  childModelId,
  onRelabel,
  onDescribe,
  onAddStep,
  onDecompose,
  onOpenChild,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  nodeId: UUID;
  level: string | null;
  childModelId: UUID | null;
  onRelabel: (name: string) => void;
  onDescribe: (description: string) => void;
  onAddStep: (step: SuggestedStep) => void;
  onDecompose: (subSteps: SubStep[]) => void;
  onOpenChild: (childModelId: UUID) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { entry, runAction, resolveStep, clear } = useAiEditNode(nodeId);

  const decomposeAllowed = canDecompose(level);

  function handleMenuAction(action: AiEditAction) {
    setMenuOpen(false);
    runAction({ projectId, modelId, versionId, action });
  }

  const baseActions: { action: AiEditAction; label: string }[] = [
    { action: "relabel", label: "Relabel step" },
    { action: "describe", label: "Describe step" },
    { action: "validate", label: "Validate completeness" },
    { action: "suggest_next", label: "Suggest next step" },
  ];

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-700"
      >
        <Sparkles size={11} />
        Ask AI to edit this step
      </button>

      {menuOpen && (
        <div role="menu" className="mt-1 rounded-md border border-slate-200 bg-white py-1 shadow">
          {baseActions.map((a) => (
            <button
              key={a.action}
              role="menuitem"
              type="button"
              onClick={() => handleMenuAction(a.action)}
              className="block w-full px-3 py-1.5 text-left text-[11px] text-slate-700 hover:bg-slate-50"
            >
              {a.label}
            </button>
          ))}
          {childModelId && (
            <button
              role="menuitem"
              type="button"
              onClick={() => { setMenuOpen(false); onOpenChild(childModelId); }}
              className="block w-full px-3 py-1.5 text-left text-[11px] font-semibold text-violet-700 hover:bg-slate-50"
            >
              Open sub-process
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            disabled={!decomposeAllowed}
            title={decomposeAllowed ? undefined : "Already at the most detailed level (L4)"}
            onClick={() => decomposeAllowed && handleMenuAction("decompose")}
            className="block w-full px-3 py-1.5 text-left text-[11px] text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            {childModelId ? "Re-decompose (new version)" : "Decompose into sub-steps"}
          </button>
        </div>
      )}

      {entry.loading && <LoadingSkeleton action={entry.loadingAction} />}
      {entry.error && <p className="mt-2 text-[11px] text-rose-600">{entry.error}</p>}

      {entry.result && (
        <ProposalCards
          result={entry.result}
          pendingSteps={entry.pendingSteps}
          isReDecompose={!!childModelId}
          onRelabel={(name) => { onRelabel(name); clear(); }}
          onDescribe={(d) => { onDescribe(d); clear(); }}
          onResolveStep={(step, accept) => {
            if (accept) onAddStep(step);
            resolveStep(step);
          }}
          onDecompose={(subSteps) => { onDecompose(subSteps); clear(); }}
          onDismiss={clear}
        />
      )}
    </div>
  );
}
```

Add the `decompose` rendering branch to `ProposalCards`. Update its props (line ~207) to accept `isReDecompose` and `onDecompose`, then add the branch before `return null`:

```tsx
function ProposalCards({
  result,
  pendingSteps,
  isReDecompose,
  onRelabel,
  onDescribe,
  onResolveStep,
  onDecompose,
  onDismiss,
}: {
  result: AiEditResponse;
  pendingSteps: SuggestedStep[] | null;
  isReDecompose: boolean;
  onRelabel: (name: string) => void;
  onDescribe: (description: string) => void;
  onResolveStep: (step: SuggestedStep, accept: boolean) => void;
  onDecompose: (subSteps: SubStep[]) => void;
  onDismiss: () => void;
}) {
  // …existing relabel / describe / validate / suggest_next branches unchanged…

  if (result.decompose) {
    const steps = result.decompose.sub_steps;
    if (steps.length === 0) {
      return (
        <p className="mt-2 text-[11px] text-slate-500">
          The sources don&apos;t support a breakdown of this step.
        </p>
      );
    }
    return (
      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50/60 p-2">
        <p className="text-[11px] font-semibold text-slate-800">
          {steps.length} sub-step{steps.length > 1 ? "s" : ""}
        </p>
        {isReDecompose && (
          <p className="mt-0.5 text-[10px] text-amber-700">
            Creates a new version of the existing sub-process; the current version is kept in history.
          </p>
        )}
        <ol className="mt-1 list-decimal space-y-1 pl-4">
          {steps.map((s, i) => (
            <li key={i} className="text-[10px] text-slate-700">
              <span className="font-medium">{s.proposed_name}</span>
              <span className="text-slate-400"> · {s.proposed_type} · {s.role}</span>
              {s.cited_claim_ids.length === 0 && (
                <span className="ml-1 italic text-amber-700">(inference)</span>
              )}
            </li>
          ))}
        </ol>
        <AcceptReject onAccept={() => onDecompose(steps)} onReject={onDismiss} />
      </div>
    );
  }
  return null;
}
```

- [ ] **Step 3: Typecheck + run the frontend test suite**

Run: `npx tsc --noEmit`
Expected: errors ONLY in `properties-panel.tsx` and the page (they don't yet pass `level`/`childModelId`/`onDecompose`/`onOpenChild`) — those are fixed in Tasks 16-17. The panel and cache themselves must be error-free. If any error is inside `ai-edit-panel.tsx`/`ai-edit-cache.tsx`, fix it now.

Run: `npm test -- decompose-nav`
Expected: still PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/ai-edit-cache.tsx src/components/canvas/ai-edit-panel.tsx
git commit -m "$(cat <<'EOF'
feat(sp5b): decompose action menu + proposal card (open / re-decompose)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Properties panel — thread props + Remove control

**Files:**
- Modify: `src/components/canvas/properties-panel.tsx`

- [ ] **Step 1: Extend props**

In `src/components/canvas/properties-panel.tsx`, **add** these props to the existing props type (do not alter `onUpdate`/`onAddStep` — leave their current signatures exactly as they are). Place `level` near `modelId`/`versionId` (line ~48) and the three callbacks near `onAddStep` (line ~61), and add matching entries to the destructure (line ~36):

```typescript
  level: string | null;
  onDecompose?: (sourceId: UUID, subSteps: SubStep[]) => void;
  onOpenChild?: (childModelId: UUID) => void;
  onRemoveChild?: (sourceId: UUID) => void;
```

Add the `SubStep` type to the existing `@/lib/types` import in this file.

The `selected` prop's type is `CanvasSelection`'s node variant (it already includes `description`); since Task 11 added `childModelId` to that variant, `selected.childModelId` is available with no further change here. Confirm the panel's `selected` prop type resolves to that variant.

- [ ] **Step 2: Pass new props to `AiEditPanel`**

Update the `<AiEditPanel>` usage (line ~268):

```tsx
        <AiEditPanel
          projectId={projectId}
          modelId={modelId}
          versionId={versionId}
          nodeId={selected.id}
          level={level}
          childModelId={selected.childModelId ?? null}
          onRelabel={(name) => onUpdate?.(selected.id, { name })}
          onDescribe={(description) => {
            setDescriptionDraft(description);
            onUpdate?.(selected.id, { description });
          }}
          onAddStep={(step) => onAddStep?.(selected.id, step)}
          onDecompose={(subSteps) => onDecompose?.(selected.id, subSteps)}
          onOpenChild={(childModelId) => onOpenChild?.(childModelId)}
        />
```

- [ ] **Step 3: Add a "Remove sub-process" control**

Immediately after the `<AiEditPanel … />` element, add:

```tsx
        {selected.childModelId && (
          <button
            type="button"
            onClick={() => onRemoveChild?.(selected.id)}
            className="mt-2 w-full rounded-md border border-rose-200 px-2.5 py-1.5 text-[11px] font-medium text-rose-700 hover:bg-rose-50"
          >
            Remove sub-process
          </button>
        )}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors ONLY remain in the page (Task 17), which doesn't yet pass `level`/`onDecompose`/`onOpenChild`/`onRemoveChild`. No errors inside `properties-panel.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/properties-panel.tsx
git commit -m "$(cat <<'EOF'
feat(sp5b): properties panel threads decompose props + Remove sub-process

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Page wiring — breadcrumb, drill-in, accept, remove

**Files:**
- Create: `src/components/canvas/level-breadcrumb.tsx`
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx`

- [ ] **Step 1: Create the breadcrumb component**

Create `src/components/canvas/level-breadcrumb.tsx`:

```tsx
"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { BreadcrumbItem } from "@/components/canvas/decompose-nav";

export function LevelBreadcrumb({ items }: { items: BreadcrumbItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Process levels"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "6px 12px",
        background: "rgba(255,255,255,0.96)",
        borderRadius: 8,
        border: "1px solid #e2e8f0",
        boxShadow: "0 8px 28px -8px rgba(15, 23, 42, 0.18)",
        fontSize: 12,
        maxWidth: 520,
        overflow: "hidden",
      }}
    >
      {items.map((it, i) => (
        <span key={it.modelId} style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          {i > 0 && <ChevronRight size={12} color="#94a3b8" />}
          {it.current || !it.href ? (
            <span
              title={`${it.level} · ${it.label}`}
              style={{
                fontWeight: it.current ? 600 : 500,
                color: it.current ? "#0f172a" : "#64748b",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 160,
              }}
            >
              {it.label}
            </span>
          ) : (
            <Link
              href={it.href}
              title={`${it.level} · ${it.label}`}
              style={{
                color: "#475569",
                textDecoration: "none",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 140,
              }}
            >
              {it.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Wire queries + handlers into the page**

In the canvas page, add imports:

```tsx
import { toast } from "sonner";
import { LevelBreadcrumb } from "@/components/canvas/level-breadcrumb";
import { buildBreadcrumb } from "@/components/canvas/decompose-nav";
import type { SubStep, UUID } from "@/lib/types";   // extend the existing type import
```
(Confirm `sonner`'s `toast` import path matches the rest of the codebase — `bpmn-canvas.tsx` already imports `toast`; copy that exact import.)

Add the two queries after the existing `reviewState` query (line ~176):

```tsx
  const { data: mapModel } = useQuery({
    queryKey: ["map-model", params.id, params.modelId],
    queryFn: () => api.getProcessMap(params.id, params.modelId),
  });

  const { data: ancestry } = useQuery({
    queryKey: ["ancestry", params.id, params.modelId],
    queryFn: () => api.getMapAncestry(params.id, params.modelId),
  });

  const breadcrumb = useMemo(
    () => (ancestry ? buildBreadcrumb(ancestry, params.id) : []),
    [ancestry, params.id]
  );
```

Add the handlers near `handleAddStep` (line ~108):

```tsx
  const handleDrillIntoNode = useCallback(
    async (childModelId: UUID) => {
      try {
        const child = await api.getProcessMap(params.id, childModelId);
        if (child.latest_version_id) {
          router.push(`/projects/${params.id}/maps/${childModelId}/versions/${child.latest_version_id}`);
        } else {
          toast.error("That sub-process has no version to open.");
        }
      } catch {
        toast.error("Couldn't open the sub-process.");
      }
    },
    [router, params.id]
  );

  const handleDecompose = useCallback(
    async (sourceId: UUID, subSteps: SubStep[]) => {
      try {
        const res = await api.applyDecompose(params.id, params.modelId, params.versionId, sourceId, {
          sub_steps: subSteps,
        });
        toast.success("Sub-process created.");
        router.push(`/projects/${params.id}/maps/${res.child_model_id}/versions/${res.child_version_id}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Decompose failed.");
      }
    },
    [router, params.id, params.modelId, params.versionId]
  );

  const handleRemoveChild = useCallback(
    async (sourceId: UUID) => {
      try {
        await api.removeSubProcess(params.id, params.modelId, params.versionId, sourceId);
        toast.success("Sub-process removed.");
        // The parent node's child_model_id is gone — refresh the graph so the
        // "+" marker drops and the selection reflects no child.
        queryClient.invalidateQueries({
          queryKey: ["graph", params.id, params.modelId, params.versionId],
        });
        setSelected({ kind: "none" });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't remove the sub-process.");
      }
    },
    [queryClient, params.id, params.modelId, params.versionId]
  );
```

- [ ] **Step 3: Render the breadcrumb + pass props**

In the top floating bar, add the breadcrumb next to the "Maps" button (inside the left-hand `pointerEvents:auto` div, after the counts chip, line ~262):

```tsx
          {breadcrumb.length > 0 && <LevelBreadcrumb items={breadcrumb} />}
```

Pass `onDrillIntoNode` to `<BpmnCanvas>` (line ~313):

```tsx
          onCountsChange={handleCountsChange}
          onDrillIntoNode={handleDrillIntoNode}
```

Pass the new props to `<PropertiesPanel>` (line ~349):

```tsx
          <PropertiesPanel
            projectId={params.id}
            modelId={params.modelId}
            versionId={params.versionId}
            level={mapModel?.level ?? null}
            selected={selectedNode}
            lanes={data.lanes}
            collapsed={propertiesCollapsed}
            onCollapsedChange={setPropertiesCollapsed}
            onDelete={handleNodeDelete}
            onUpdate={handleNodeUpdate}
            onAddStep={handleAddStep}
            onDecompose={handleDecompose}
            onOpenChild={handleDrillIntoNode}
            onRemoveChild={handleRemoveChild}
            review={/* …unchanged… */}
          />
```

(`selectedNode` is the node selection; Task 11 added `childModelId` to it, so `<PropertiesPanel selected={selectedNode}>` carries the child link through.)

- [ ] **Step 4: Typecheck + frontend suite**

Run: `npx tsc --noEmit`
Expected: no errors anywhere.

Run: `npm test`
Expected: all pass (existing suite + `decompose-nav`).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx" src/components/canvas/level-breadcrumb.tsx
git commit -m "$(cat <<'EOF'
feat(sp5b): page wiring — breadcrumb, drill-in, decompose accept, remove

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Full verification + live-smoke checklist

**Files:** none (verification); update `docs/superpowers/plans/2026-06-01-sp5b-decompose-level.md` with an outcome note at the end.

- [ ] **Step 1: Backend gate**

Run: `cd backend && python -m pytest -q`
Expected: all pass.

- [ ] **Step 2: Frontend gates**

Run: `npx tsc --noEmit` → no errors.
Run: `npm test` → all pass.
Run (advisory): `npm run lint` → no NEW errors beyond the 7 pre-existing ([[frontend-lint-baseline]]).

- [ ] **Step 3: Live smoke (best-effort; needs a real `ANTHROPIC_API_KEY` in `backend/.env`)**

Start `./run-local.sh`. If the key is blank, decompose returns 502 — document that and skip the AI steps; the non-AI steps (marker, drill-in, breadcrumb, remove) can still be exercised by seeding a child via the apply endpoint directly. With a key:
1. Open an **L2** map, select a step, **Ask AI → Decompose into sub-steps** → cards list ordered sub-steps with rationale/claim chips.
2. **Accept** → lands in the new child (L3) map; toast shows.
3. Return to the parent (breadcrumb root crumb or back) → the step shows the **`+`** marker.
4. **Double-click** the marked step → drills into the child.
5. **Breadcrumb** shows `root ▸ step`; click the root crumb → returns to the parent's latest version.
6. Re-select the step → **Re-decompose (new version)** → Accept → child now has v2 (check the Versions tab).
7. **Remove sub-process** (Properties) → the `+` marker drops; the child leaves the Maps list.
8. At an **L4** map, the Decompose menu item is disabled with the tooltip.

- [ ] **Step 4: Record the outcome**

Append an "## Execution outcome" section to this plan noting: gates (pytest/tsc/vitest counts), any deviations from the plan, and live-smoke results (or why skipped). Commit:

```bash
git add docs/superpowers/plans/2026-06-01-sp5b-decompose-level.md
git commit -m "$(cat <<'EOF'
docs(sp5b): record decompose-level execution outcome

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Finish the branch**

Use **superpowers:finishing-a-development-branch** to open the stacked PR (base `main`).

---

## Notes for the implementer

- **No migration.** SP-5b stores `child_model_id` in `ProcessNode.properties` (JSONB) — same pattern as `_lineage_id`/`description`/`ai_proposed`. Do not add an Alembic migration.
- **Position is intentionally empty** on child sub-step nodes — `buildCanvasState` falls back to Dagre LR layout, which spaces a linear chain correctly. Don't compute positions server-side.
- **Re-decompose ≠ merge.** It appends a fresh child version; reconciliation with hand-edits is the user's job via SP-4 diff/restore. Don't attempt a graph merge.
- **The decomposed parent node is never marked `ai_proposed`** — it already exists and is sourced. Only the child's sub-steps are.
- **Route ordering:** `GET /process-maps/{model_id}` sits between the list route and the version routes. After adding it, run the app-import smoke (Task 8 Step 4) to catch any path-collision/registration error early.
- **`toast`/`sonner`:** copy the exact import already used in `bpmn-canvas.tsx` rather than guessing the package path.

---

## Execution outcome

_Executed 2026-06-01 via superpowers:subagent-driven-development (fresh implementer + spec & code-quality review per task, plus a final holistic review)._

**Gates (all green on the branch tip):**
- Backend `pytest -q`: **113 passed** (24 new tests in `backend/tests/test_decompose.py`).
- `npx tsc --noEmit`: **clean**.
- `npm test` (Vitest): **39 passed / 8 files** (incl. the new `decompose-nav.test.ts`).
- `eslint` (advisory): **no new errors/warnings** in SP-5b files; the repo's pre-existing lint debt is untouched.

**All 18 tasks landed as planned** (16 feature commits on top of the 2 doc commits), each squarely matching the spec under two-stage review.

**Deviations / fixes during execution:**
- **Apply claim-scope (spec reconciled, not code-changed):** `apply_decompose` re-guards cited claims to **project scope** (one `Claim.project_id` query), mirroring SP-5a suggest-next, rather than re-filtering to node+neighbor scope. The propose endpoint already neighbor-filters the surviving refs, so in the real flow nothing is dropped at apply; project-scope is defense-in-depth and keeps provenance truthful. The design spec's Apply section was updated to describe this.
- **Robustness:** `apply_decompose` / `remove_sub_process` guard `UUID(child_model_id)` parsing (corrupt JSONB → treat as no child / create fresh) — added with a regression test.
- **Final-review fixes (commit `8d9b9df`):** the canvas is uncontrolled, so query invalidation alone doesn't refresh the mounted graph. Added an imperative `BpmnCanvasHandle.clearChildModelId(id)` called by the Remove handler (drops the `+` marker in place), and added a parent-graph `invalidateQueries` on decompose-accept so the marker shows on back-navigation within the 30s staleTime.

**Known minor follow-ups (non-blocking):**
- `get_map_ancestry` does not filter `deleted_at` on walked ancestors — a soft-deleted ancestor would still render a breadcrumb crumb. Edge case (mid-chain ancestor deletion isn't reachable through the normal UI).
- Breadcrumb hard-clips (rather than ellipsing) at max L4 depth with very long labels — cosmetic.
- `mapModel`/`ancestry` queries fire on every canvas mount without an `enabled: !!data` gate (two cheap reads); the breadcrumb appears slightly earlier as a result.

**Live smoke:** deferred to manual — local `.env` `ANTHROPIC_API_KEY` is typically blank, so the AI propose path returns 502 without a key. The non-AI paths (marker render, double-click drill-in, breadcrumb, remove) and the apply/ancestry/remove endpoints are covered by the pytest suite end-to-end against a real DB.
