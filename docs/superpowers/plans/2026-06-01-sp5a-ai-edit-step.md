# SP-5a — AI edit-this-step (node-local actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the disabled "Ask AI to edit this step" button to an action menu of four grounded, propose-then-apply AI actions for the selected node (relabel, describe, validate-completeness, suggest-next-step), with AI-created steps marked `ai_proposed` and rendered visibly distinct.

**Architecture:** A new backend service (`map_ai_edit.py`) reuses the existing map-chat grounding context and the established Anthropic *forced-tool* pattern (one tool per action) to return structured proposals. A new propose endpoint resolves the model's claim citations back to real UUIDs and drops fabricated ones. Apply paths reuse the existing node-edit/undo plumbing (relabel/describe) plus one new atomic endpoint that inserts an `ai_proposed` node+edge (suggest-next). The frontend adds a Description field, an action menu + proposal cards in the Properties panel, and distinct canvas styling for `ai_proposed` nodes/edges.

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic (backend, `anthropic==0.40.0`), Next.js 16 + React 19 + TypeScript (frontend), pytest + Vitest.

**Design doc:** `docs/superpowers/specs/2026-06-01-sp5a-ai-edit-step-design.md`

---

## File structure

**Backend — create:**
- `backend/app/services/map_context.py` — `assemble_map_context(db, version, selected_node_id)` → grounding text + `claim_ref_to_id` map. Extracted from `chat_with_map` so chat and ai-edit share one renderer.
- `backend/app/services/map_ai_edit.py` — one forced-tool function per action; returns dataclass proposals citing short claim refs.
- `backend/app/schemas/version_ai_edit.py` — request + proposal response schemas.
- `backend/tests/test_ai_edit.py` — service + endpoint + apply tests.
- `backend/tests/test_map_context.py` — context-builder unit test.

**Backend — modify:**
- `backend/app/api/v2/process_maps.py` — repoint `chat_with_map` to `assemble_map_context`; add propose endpoint + apply-step endpoint; extend `update_node` for `description`.
- `backend/app/schemas/process_map.py` — add `description` to `NodeUpdate`.

**Frontend — create:**
- `src/components/canvas/ai-edit.ts` (+ `.test.ts`) — pure helpers: `placeProposedStep`, `isEdgeProposed`.
- `src/components/canvas/ai-edit-panel.tsx` (+ `.test.tsx`) — action menu + proposal cards.

**Frontend — modify:**
- `src/lib/types.ts` — `description` on `NodeUpdate`; AI-edit proposal types.
- `src/lib/api.ts` — `aiEditNode`, `applyProposedStep`; `description` flows through `updateNode`.
- `src/components/canvas/types.ts` — `aiProposed?`, `description?` on `CanvasNode`; `description?` on the `node` selection.
- `src/components/canvas/layout.ts` — map `properties.ai_proposed` / `properties.description` in `buildCanvasState`.
- `src/components/canvas/shapes.tsx` — `ai_proposed` styling in `NodeShape` + `EdgeArrow`.
- `src/components/canvas/bpmn-canvas.tsx` — `CanvasSelection.node.description`; `updateNode` handles `description`; new `addProposedStep` handle method; carry `aiProposed`/`description` through renderNodes/selection.
- `src/components/canvas/properties-panel.tsx` — Description field; mount `<AiEditPanel>`; accept `modelId`/`versionId`.
- `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — pass `modelId`/`versionId` to PropertiesPanel; `description` in the update patch; `addProposedStep` wiring.

---

## Conventions (read once)

- **Commit locally only. Never push.** End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Never use `rm`/`git rm`.**
- **Backend tests** need the `poet_test` DB. Run from `backend/` with the venv: `cd backend && .venv/bin/pytest <args>`.
- **Frontend tests:** `npm test -- <file>` (Vitest). Type-check: `npx tsc --noEmit`.
- Lint is advisory; binding gates are tsc + Vitest + pytest.
- The Anthropic forced-tool pattern to mirror lives in `backend/app/services/conflict_detection.py` (module-level TOOL dict, `tool_choice={"type":"tool","name":...}`, iterate `response.content` for `block.type == "tool_use"`, read `block.input`).

---

## Task 1: Extract the shared map-context builder

DRYs the grounding-context assembly out of `chat_with_map` so the ai-edit endpoint reuses it, and exposes the `claim_ref → UUID` map needed for citation hygiene.

**Files:**
- Create: `backend/app/services/map_context.py`
- Create: `backend/tests/test_map_context.py`
- Modify: `backend/app/api/v2/process_maps.py:1104-1230` (replace the inline assembly in `chat_with_map`)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_map_context.py`:

```python
"""Unit test for the shared map-context builder used by chat + ai-edit."""
from uuid import uuid4

from app.enums import ClaimLinkKind
from app.models.claim import Claim
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
from app.services.map_context import assemble_map_context


def _seed_version(db):
    org = Organization(name="O")
    db.add(org)
    db.flush()
    user = User(organization_id=org.id, email=f"u-{uuid4()}@x.io", name="U")
    db.add(user)
    db.flush()
    project = Project(organization_id=org.id, name="P", created_by=user.id)
    db.add(project)
    db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2")
    db.add(model)
    db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1)
    db.add(version)
    db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0)
    db.add(lane)
    db.flush()
    n1 = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="Receive",
        position={}, properties={},
    )
    n2 = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="Approve",
        position={}, properties={},
    )
    db.add_all([n1, n2])
    db.flush()
    db.add(ProcessEdge(version_id=version.id, source_node_id=n1.id, target_node_id=n2.id))
    claim = Claim(project_id=project.id, kind="task", subject="Clerk receives the order", normalized={})
    db.add(claim)
    db.flush()
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    return project, version, n1, claim


def test_assemble_map_context_text_and_refs(db):
    project, version, n1, claim = _seed_version(db)
    ctx = assemble_map_context(db, version, selected_node_id=n1.id)

    assert "Receive" in ctx.text and "Approve" in ctx.text
    assert "Clerk receives the order" in ctx.text
    # Selected label names the selected node.
    assert "Receive" in (ctx.selected_label or "")
    # The single project claim is presented as C1 and maps back to its UUID.
    assert ctx.claim_ref_to_id["C1"] == claim.id


def test_assemble_map_context_no_selection(db):
    project, version, n1, claim = _seed_version(db)
    ctx = assemble_map_context(db, version, selected_node_id=None)
    assert ctx.selected_label is None
    assert "Approve" in ctx.text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_map_context.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.map_context'`.

- [ ] **Step 3: Write the builder**

Create `backend/app/services/map_context.py`:

```python
"""Shared grounding-context builder for the map AI features.

Both the in-canvas chat and the per-node ai-edit endpoint need the same
compact rendering of the current map (lanes/nodes/edges) plus the project's
claims with their first verbatim citation. Extracted here so there is one
renderer and one claim-ref scheme.
"""
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.claim import Claim, ClaimCitation
from app.models.input import Chunk, DocumentSection, Input
from app.models.process import (
    NodeClaimLink,
    ProcessEdge,
    ProcessLane,
    ProcessNode,
    ProcessVersion,
)
from app.services.map_chat import build_map_context


@dataclass
class MapContext:
    text: str
    selected_label: str | None
    node_ref_by_id: dict[UUID, str]
    claim_ref_to_id: dict[str, UUID]


def assemble_map_context(
    db: Session,
    version: ProcessVersion,
    selected_node_id: UUID | None = None,
) -> MapContext:
    """Load the version's graph + the project's claims and render the compact
    grounding text. Returns the text, a selected-node label, and the maps that
    let a caller resolve the short refs (N1, C1, ...) the model cites back."""
    lanes = list(
        db.scalars(
            select(ProcessLane)
            .where(ProcessLane.version_id == version.id)
            .order_by(ProcessLane.order_index)
        ).all()
    )
    nodes = list(
        db.scalars(select(ProcessNode).where(ProcessNode.version_id == version.id)).all()
    )
    edges = list(
        db.scalars(select(ProcessEdge).where(ProcessEdge.version_id == version.id)).all()
    )

    lane_ref_by_id = {l.id: f"L{i + 1}" for i, l in enumerate(lanes)}
    node_ref_by_id = {n.id: f"N{i + 1}" for i, n in enumerate(nodes)}

    lanes_ctx = [{"idx": i + 1, "name": l.name} for i, l in enumerate(lanes)]
    nodes_ctx = [
        {
            "idx": i + 1,
            "label": n.name,
            "type": n.type,
            "lane_ref": lane_ref_by_id.get(n.lane_id) if n.lane_id else None,
        }
        for i, n in enumerate(nodes)
    ]
    edges_ctx = [
        {
            "idx": i + 1,
            "source_ref": node_ref_by_id.get(e.source_node_id, "?"),
            "target_ref": node_ref_by_id.get(e.target_node_id, "?"),
            "label": e.label,
        }
        for i, e in enumerate(edges)
    ]

    # Which project claims attach to which node in this version (for the
    # "[attached to N#]" annotation).
    node_claim_rows = list(
        db.execute(
            select(NodeClaimLink.claim_id, NodeClaimLink.node_id)
            .join(ProcessNode, NodeClaimLink.node_id == ProcessNode.id)
            .where(ProcessNode.version_id == version.id)
        ).all()
    )
    attached_node_by_claim = {
        claim_id: node_ref_by_id.get(node_id, "?") for claim_id, node_id in node_claim_rows
    }

    model = db.get(type(version), version.id)  # noqa: F841 (kept explicit below)
    project_id = (
        db.scalars(
            select(ProcessLane.version_id).where(ProcessLane.version_id == version.id).limit(1)
        ).first()
    )
    # Resolve project id via the model the version belongs to.
    from app.models.process import ProcessModel  # local import avoids a cycle at import time

    pm = db.get(ProcessModel, version.model_id)
    project_id = pm.project_id if pm else None

    project_claims = (
        list(db.scalars(select(Claim).where(Claim.project_id == project_id)).all())
        if project_id
        else []
    )
    project_claim_ids = [c.id for c in project_claims]

    quote_by_claim: dict[UUID, str] = {}
    source_by_claim: dict[UUID, str] = {}
    if project_claim_ids:
        cit_rows = list(
            db.execute(
                select(ClaimCitation.claim_id, ClaimCitation.quote, Input.name)
                .join(Chunk, Chunk.id == ClaimCitation.chunk_id)
                .join(DocumentSection, DocumentSection.id == Chunk.section_id)
                .join(Input, Input.id == DocumentSection.input_id)
                .where(ClaimCitation.claim_id.in_(project_claim_ids))
                .order_by(ClaimCitation.created_at)
            ).all()
        )
        for claim_id, quote, input_name in cit_rows:
            if claim_id not in quote_by_claim:
                quote_by_claim[claim_id] = quote
                source_by_claim[claim_id] = input_name

    claims_ctx = [
        {
            "idx": i + 1,
            "kind": c.kind,
            "subject": c.subject,
            "attached_to": attached_node_by_claim.get(c.id),
            "quote": quote_by_claim.get(c.id),
            "source": source_by_claim.get(c.id),
        }
        for i, c in enumerate(project_claims)
    ]
    claim_ref_to_id = {f"C{i + 1}": c.id for i, c in enumerate(project_claims)}

    selected_label: str | None = None
    if selected_node_id is not None:
        sel = next((n for n in nodes if n.id == selected_node_id), None)
        if sel is not None:
            ref = node_ref_by_id.get(sel.id, "?")
            selected_label = f'{ref} (node) — "{sel.name}"'

    text = build_map_context(
        lanes=lanes_ctx,
        nodes=nodes_ctx,
        edges=edges_ctx,
        claims=claims_ctx,
        selected_label=selected_label,
    )
    return MapContext(
        text=text,
        selected_label=selected_label,
        node_ref_by_id=node_ref_by_id,
        claim_ref_to_id=claim_ref_to_id,
    )
```

> Note: the two `project_id` lines above are intentionally collapsed to the `ProcessModel` lookup — delete the dead `db.get(type(version)...)`/`select(ProcessLane.version_id)` probe lines when implementing; they're shown only to make the resolution path obvious. Final body resolves `project_id` solely via `pm = db.get(ProcessModel, version.model_id)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_map_context.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Repoint `chat_with_map` to the builder**

In `backend/app/api/v2/process_maps.py`, replace the body of `chat_with_map` from the "Load the current map state" comment through the `map_context_text = build_map_context(...)` call (≈lines 1104-1230) with:

```python
    from app.services.map_context import assemble_map_context

    selected_id = payload.selected_node_id or None
    ctx = assemble_map_context(db, version, selected_node_id=selected_id)
    # The chat also lets an edge be the selection; preserve that label.
    if selected_id is None and payload.selected_edge_id:
        edge = db.get(ProcessEdge, payload.selected_edge_id)
        if edge is not None and edge.version_id == version.id:
            src = ctx.node_ref_by_id.get(edge.source_node_id, "?")
            tgt = ctx.node_ref_by_id.get(edge.target_node_id, "?")
            label = f" '{edge.label}'" if edge.label else ""
            # Re-render with the edge selection label prepended.
            ctx_text = f"Currently selected: edge {src}->{tgt}{label}\n\n{ctx.text}"
        else:
            ctx_text = ctx.text
    else:
        ctx_text = ctx.text

    map_context_text = ctx_text
```

Leave the `history = [...]` and `run_map_chat(...)` block below it unchanged.

- [ ] **Step 6: Verify the chat endpoint still imports/builds**

Run: `cd backend && .venv/bin/python -c "import app.api.v2.process_maps"`
Expected: no error (import succeeds). Then run the full existing suite to confirm nothing regressed:
Run: `cd backend && .venv/bin/pytest -q`
Expected: PASS (existing tests green; the chat endpoint has no unit test but must still import).

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/map_context.py backend/tests/test_map_context.py backend/app/api/v2/process_maps.py
git commit -m "$(printf 'refactor(sp5a): extract shared map-context builder\n\nDRY the grounding-context assembly out of chat_with_map into\nassemble_map_context, exposing the claim-ref->UUID map the ai-edit\nendpoint needs for citation hygiene.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Proposal request/response schemas

**Files:**
- Create: `backend/app/schemas/version_ai_edit.py`
- Test: covered indirectly by Task 4; add a direct validation test here.
- Test file: `backend/tests/test_ai_edit.py` (created here, extended later)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_ai_edit.py`:

```python
"""Tests for the per-node AI-edit feature: schemas, service, endpoints."""
import pytest

from app.schemas.version_ai_edit import AiEditAction, AiEditRequest


def test_ai_edit_request_accepts_known_actions():
    for action in ["relabel", "describe", "validate", "suggest_next"]:
        req = AiEditRequest(action=action)
        assert req.action == AiEditAction(action)


def test_ai_edit_request_rejects_unknown_action():
    with pytest.raises(ValueError):
        AiEditRequest(action="delete_everything")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.schemas.version_ai_edit'`.

- [ ] **Step 3: Write the schemas**

Create `backend/app/schemas/version_ai_edit.py`:

```python
"""Schemas for the per-node AI-edit feature (SP-5a).

The propose endpoint returns one of four action-specific payloads. Each
proposal carries a human-readable rationale and the UUIDs of the project
claims that justify it (already resolved + hygiene-filtered by the endpoint).
"""
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field


class AiEditAction(StrEnum):
    RELABEL = "relabel"
    DESCRIBE = "describe"
    VALIDATE = "validate"
    SUGGEST_NEXT = "suggest_next"


class AiEditRequest(BaseModel):
    action: AiEditAction


class RelabelProposal(BaseModel):
    proposed_name: str
    unchanged: bool = False  # model judged the current label already faithful
    rationale: str
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class DescribeProposal(BaseModel):
    proposed_description: str
    rationale: str
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class ValidateGap(BaseModel):
    summary: str
    severity: str = Field(pattern=r"^(low|medium|high)$")
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class ValidateProposal(BaseModel):
    gaps: list[ValidateGap] = Field(default_factory=list)


class SuggestedStep(BaseModel):
    proposed_name: str
    proposed_type: str
    edge_label: str | None = None
    rationale: str
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class SuggestNextProposal(BaseModel):
    steps: list[SuggestedStep] = Field(default_factory=list)


class AiEditResponse(BaseModel):
    """Exactly one of the action fields is populated, matching the request."""
    action: AiEditAction
    relabel: RelabelProposal | None = None
    describe: DescribeProposal | None = None
    validate_: ValidateProposal | None = Field(default=None, alias="validate")
    suggest_next: SuggestNextProposal | None = None

    model_config = {"populate_by_name": True}


class AiProposedStepRequest(BaseModel):
    """Apply a suggested next step: create an ai_proposed node downstream of
    `source_node_id`, plus the connecting edge and any ai_proposed claim links."""
    source_node_id: UUID
    name: str = Field(min_length=1, max_length=500)
    type: str
    lane_id: UUID
    x: float
    relative_y: float
    edge_label: str | None = Field(default=None, max_length=300)
    cited_claim_ids: list[UUID] = Field(default_factory=list)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/version_ai_edit.py backend/tests/test_ai_edit.py
git commit -m "$(printf 'feat(sp5a): AI-edit request + proposal schemas\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: The `map_ai_edit` service (forced-tool, one per action)

**Files:**
- Create: `backend/app/services/map_ai_edit.py`
- Test: `backend/tests/test_ai_edit.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_ai_edit.py`:

```python
from types import SimpleNamespace
from unittest.mock import patch

from app.services import map_ai_edit


class _FakeBlock:
    def __init__(self, name, payload):
        self.type = "tool_use"
        self.name = name
        self.input = payload


class _FakeClient:
    def __init__(self, name, payload):
        self._block = _FakeBlock(name, payload)

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        return SimpleNamespace(content=[self._block])


def test_propose_relabel_parses_tool_output():
    fake = _FakeClient(
        "propose_relabel",
        {"proposed_name": "Receive purchase order", "unchanged": False,
         "rationale": "C1 says the clerk receives the order.", "cited_claim_refs": ["C1"]},
    )
    with patch.object(map_ai_edit, "_get_client", return_value=fake):
        out = map_ai_edit.propose_relabel(map_context_text="...", selected_label="N1")
    assert out["proposed_name"] == "Receive purchase order"
    assert out["cited_claim_refs"] == ["C1"]


def test_propose_suggest_next_parses_steps():
    fake = _FakeClient(
        "propose_next_steps",
        {"steps": [
            {"proposed_name": "Verify budget", "proposed_type": "task",
             "edge_label": None, "rationale": "C2 implies a budget check.",
             "cited_claim_refs": ["C2"]}]},
    )
    with patch.object(map_ai_edit, "_get_client", return_value=fake):
        out = map_ai_edit.propose_next_steps(map_context_text="...", selected_label="N1")
    assert out["steps"][0]["proposed_type"] == "task"


def test_service_raises_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    # Force a fresh client resolution.
    map_ai_edit._client = None
    with pytest.raises(RuntimeError):
        map_ai_edit._get_client()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`
Expected: FAIL — `AttributeError: module 'app.services.map_ai_edit' has no attribute ...` / import error.

- [ ] **Step 3: Write the service**

Create `backend/app/services/map_ai_edit.py`:

```python
"""Per-node AI-edit actions (SP-5a).

Each action is one synchronous Anthropic call using a single forced tool, so
the model must return structured JSON (mirrors conflict_detection.py). The
model cites claims by their short refs (C1, C2, ...) from the grounding
context; the *endpoint* resolves those refs to UUIDs and drops fabricated
ones. The service stays I/O-free apart from the Anthropic call so it is
unit-testable with a fake client.
"""
import os

import anthropic

from app.enums import NodeType
from app.services.map_chat import SYSTEM_PROMPT as CHAT_GUARDRAILS

AI_EDIT_MODEL = os.getenv("MAP_AI_EDIT_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 1200

_NODE_TYPES = [t.value for t in NodeType]

_CITED = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Short refs (e.g. C1, C2) of the claims that justify this, taken verbatim from the grounding context. Use ONLY refs that appear there; never invent one.",
}

RELABEL_TOOL = {
    "name": "propose_relabel",
    "description": "Propose a clearer, source-faithful label for the selected step.",
    "input_schema": {
        "type": "object",
        "properties": {
            "proposed_name": {"type": "string", "description": "The proposed step label. If no change is warranted, repeat the current label."},
            "unchanged": {"type": "boolean", "description": "True if the current label is already faithful and you propose no change."},
            "rationale": {"type": "string", "description": "One or two sentences, citing claim refs."},
            "cited_claim_refs": _CITED,
        },
        "required": ["proposed_name", "unchanged", "rationale", "cited_claim_refs"],
    },
}

DESCRIBE_TOOL = {
    "name": "propose_description",
    "description": "Propose a concise description of what the selected step does, grounded in the sources.",
    "input_schema": {
        "type": "object",
        "properties": {
            "proposed_description": {"type": "string"},
            "rationale": {"type": "string"},
            "cited_claim_refs": _CITED,
        },
        "required": ["proposed_description", "rationale", "cited_claim_refs"],
    },
}

VALIDATE_TOOL = {
    "name": "report_gaps",
    "description": "Report completeness gaps for the selected step: missing detail, undefined branches, unstated owners/thresholds. Empty array if none.",
    "input_schema": {
        "type": "object",
        "properties": {
            "gaps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "severity": {"type": "string", "enum": ["low", "medium", "high"]},
                        "cited_claim_refs": _CITED,
                    },
                    "required": ["summary", "severity", "cited_claim_refs"],
                },
            }
        },
        "required": ["gaps"],
    },
}

SUGGEST_TOOL = {
    "name": "propose_next_steps",
    "description": "Propose one or more steps that plausibly follow the selected step, grounded in the sources. Empty array if the sources don't support any.",
    "input_schema": {
        "type": "object",
        "properties": {
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "proposed_name": {"type": "string"},
                        "proposed_type": {"type": "string", "enum": _NODE_TYPES},
                        "edge_label": {"type": ["string", "null"]},
                        "rationale": {"type": "string"},
                        "cited_claim_refs": _CITED,
                    },
                    "required": ["proposed_name", "proposed_type", "rationale", "cited_claim_refs"],
                },
            }
        },
        "required": ["steps"],
    },
}

_ACTION_INSTRUCTIONS = {
    "relabel": "Focus on the currently selected step. Propose a clearer, source-faithful label. If the current label is already faithful, set unchanged=true and repeat it.",
    "describe": "Focus on the currently selected step. Write a concise description (1-3 sentences) of what it does, grounded only in the sources.",
    "validate": "Focus on the currently selected step. Identify completeness gaps the sources reveal (missing branches, undefined owners/thresholds, unstated exceptions). Do not invent requirements.",
    "suggest_next": "Focus on the currently selected step. Propose plausible NEXT steps grounded in the sources. If the sources don't support a next step, return an empty array rather than guessing.",
}

_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set.")
        _client = anthropic.Anthropic(api_key=api_key)
    return _client


def _run(tool: dict, action: str, map_context_text: str, selected_label: str | None) -> dict:
    system = (
        CHAT_GUARDRAILS
        + "\n\n---\nAction: "
        + _ACTION_INSTRUCTIONS[action]
        + "\n\n---\nCurrent process map (grounded source of truth):\n"
        + map_context_text
    )
    user = f"Selected: {selected_label or '(none)'}. Use the {tool['name']} tool."
    client = _get_client()
    response = client.messages.create(
        model=AI_EDIT_MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
        messages=[{"role": "user", "content": user}],
        timeout=60.0,
    )
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool["name"]:
            return dict(block.input)
    return {}  # malformed/empty tool call → caller treats as empty proposal


def propose_relabel(*, map_context_text: str, selected_label: str | None) -> dict:
    return _run(RELABEL_TOOL, "relabel", map_context_text, selected_label)


def propose_description(*, map_context_text: str, selected_label: str | None) -> dict:
    return _run(DESCRIBE_TOOL, "describe", map_context_text, selected_label)


def report_gaps(*, map_context_text: str, selected_label: str | None) -> dict:
    return _run(VALIDATE_TOOL, "validate", map_context_text, selected_label)


def propose_next_steps(*, map_context_text: str, selected_label: str | None) -> dict:
    return _run(SUGGEST_TOOL, "suggest_next", map_context_text, selected_label)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_ai_edit.py backend/tests/test_ai_edit.py
git commit -m "$(printf 'feat(sp5a): map_ai_edit service (forced-tool per action)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Propose endpoint with citation hygiene

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (add endpoint + imports)
- Test: `backend/tests/test_ai_edit.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_ai_edit.py`:

```python
from fastapi import HTTPException

from app.api.v2 import process_maps as pm_api


def test_propose_endpoint_resolves_and_filters_claim_refs(db):
    from app.api.v2.deps import get_project_or_404  # noqa: F401  (ensures module import)
    project, version, n1, claim = _seed_version_for_endpoint(db)

    # Model cites a real ref (C1) and a fabricated one (C99).
    fake_payload = {
        "proposed_name": "Receive PO",
        "unchanged": False,
        "rationale": "C1 supports this.",
        "cited_claim_refs": ["C1", "C99"],
    }
    with patch.object(pm_api, "propose_relabel", return_value=fake_payload):
        resp = pm_api.ai_edit_node(
            project=project,
            model_id=version.model_id,
            version_id=version.id,
            node_id=n1.id,
            payload=pm_api.AiEditRequest(action="relabel"),
            db=db,
        )
    assert resp.relabel.proposed_name == "Receive PO"
    # C99 (fabricated) dropped; only C1's real UUID survives.
    assert resp.relabel.cited_claim_ids == [claim.id]


def test_propose_endpoint_404_for_foreign_node(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.ai_edit_node(
            project=project,
            model_id=version.model_id,
            version_id=version.id,
            node_id=uuid4(),
            payload=pm_api.AiEditRequest(action="relabel"),
            db=db,
        )
    assert exc.value.status_code == 404


# Reuse the Task 1 seed but return project as the dependency would (the
# Project object), not just its id.
def _seed_version_for_endpoint(db):
    from app.services.map_context import assemble_map_context  # noqa: F401
    from test_map_context import _seed_version  # local helper reuse
    return _seed_version(db)
```

> If cross-module import of `_seed_version` is awkward in your runner, copy the `_seed_version` body into `test_ai_edit.py` as a private helper rather than importing it. Do not leave a placeholder.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`
Expected: FAIL — `AttributeError: module 'app.api.v2.process_maps' has no attribute 'ai_edit_node'`.

- [ ] **Step 3: Add imports + endpoint**

In `backend/app/api/v2/process_maps.py`, add near the other service imports (after line 62):

```python
from app.services.map_ai_edit import (
    propose_relabel,
    propose_description,
    report_gaps,
    propose_next_steps,
)
from app.schemas.version_ai_edit import (
    AiEditAction,
    AiEditRequest,
    AiEditResponse,
    AiProposedStepRequest,
    DescribeProposal,
    RelabelProposal,
    SuggestNextProposal,
    SuggestedStep,
    ValidateGap,
    ValidateProposal,
)
```

Then add the endpoint (place it just after `chat_with_map`):

```python
def _resolve_refs(refs, claim_ref_to_id):
    """Map the model's short claim refs to real UUIDs; drop any not present in
    the grounding context (defeats fabricated citations)."""
    out = []
    for r in refs or []:
        cid = claim_ref_to_id.get(str(r).strip().upper())
        if cid is not None and cid not in out:
            out.append(cid)
    return out


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/nodes/{node_id}/ai-edit",
    response_model=AiEditResponse,
)
def ai_edit_node(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    node_id: UUID,
    payload: AiEditRequest,
    db: Annotated[Session, Depends(get_db)],
) -> AiEditResponse:
    """Propose an AI edit for one node. Never mutates: returns structured
    proposals the user accepts or rejects. Model claim citations are resolved
    to UUIDs and fabricated refs dropped."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    node = db.get(ProcessNode, node_id)
    if node is None or node.version_id != version.id:
        raise HTTPException(status_code=404, detail="Node not found in this version")

    from app.services.map_context import assemble_map_context

    ctx = assemble_map_context(db, version, selected_node_id=node.id)

    try:
        if payload.action == AiEditAction.RELABEL:
            raw = propose_relabel(map_context_text=ctx.text, selected_label=ctx.selected_label)
            return AiEditResponse(
                action=payload.action,
                relabel=RelabelProposal(
                    proposed_name=raw.get("proposed_name", node.name),
                    unchanged=bool(raw.get("unchanged", False)),
                    rationale=raw.get("rationale", ""),
                    cited_claim_ids=_resolve_refs(raw.get("cited_claim_refs"), ctx.claim_ref_to_id),
                ),
            )
        if payload.action == AiEditAction.DESCRIBE:
            raw = propose_description(map_context_text=ctx.text, selected_label=ctx.selected_label)
            return AiEditResponse(
                action=payload.action,
                describe=DescribeProposal(
                    proposed_description=raw.get("proposed_description", ""),
                    rationale=raw.get("rationale", ""),
                    cited_claim_ids=_resolve_refs(raw.get("cited_claim_refs"), ctx.claim_ref_to_id),
                ),
            )
        if payload.action == AiEditAction.VALIDATE:
            raw = report_gaps(map_context_text=ctx.text, selected_label=ctx.selected_label)
            gaps = [
                ValidateGap(
                    summary=g.get("summary", ""),
                    severity=g.get("severity", "low"),
                    cited_claim_ids=_resolve_refs(g.get("cited_claim_refs"), ctx.claim_ref_to_id),
                )
                for g in raw.get("gaps", [])
            ]
            return AiEditResponse(action=payload.action, validate=ValidateProposal(gaps=gaps))
        # SUGGEST_NEXT
        raw = propose_next_steps(map_context_text=ctx.text, selected_label=ctx.selected_label)
        steps = [
            SuggestedStep(
                proposed_name=s.get("proposed_name", ""),
                proposed_type=s.get("proposed_type", "task"),
                edge_label=s.get("edge_label"),
                rationale=s.get("rationale", ""),
                cited_claim_ids=_resolve_refs(s.get("cited_claim_refs"), ctx.claim_ref_to_id),
            )
            for s in raw.get("steps", [])
            if s.get("proposed_name")
        ]
        return AiEditResponse(action=payload.action, suggest_next=SuggestNextProposal(steps=steps))
    except RuntimeError as exc:  # missing API key, etc.
        raise HTTPException(status_code=502, detail=str(exc)) from exc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`
Expected: PASS (relabel resolves to `[claim.id]`; foreign node → 404).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_ai_edit.py
git commit -m "$(printf 'feat(sp5a): propose endpoint with claim-citation hygiene\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: Describe-apply — `NodeUpdate.description`

**Files:**
- Modify: `backend/app/schemas/process_map.py:57-65` (`NodeUpdate`)
- Modify: `backend/app/api/v2/process_maps.py:537-548` (`update_node`)
- Test: `backend/tests/test_ai_edit.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_ai_edit.py`:

```python
from app.schemas.process_map import NodeUpdate


def test_update_node_writes_description_preserving_other_properties(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    # Seed an existing property so we can prove it's preserved.
    n1.properties = {"_lineage_id": str(n1.id)}
    db.commit()

    result = pm_api.update_node(
        project=project,
        node_id=n1.id,
        payload=NodeUpdate(description="Clerk logs the order into SAP."),
        db=db,
    )
    assert result.properties["description"] == "Clerk logs the order into SAP."
    assert result.properties["_lineage_id"] == str(n1.id)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py::test_update_node_writes_description_preserving_other_properties -v`
Expected: FAIL — `TypeError: NodeUpdate() got an unexpected keyword argument 'description'` (or validation error).

- [ ] **Step 3: Add `description` to schema + apply it**

In `backend/app/schemas/process_map.py`, add to `NodeUpdate`:

```python
    description: str | None = Field(default=None, max_length=5000)
```

In `backend/app/api/v2/process_maps.py` `update_node`, after the `if payload.type is not None:` block and before the position block, add:

```python
    if payload.description is not None:
        new_props = dict(node.properties or {})
        new_props["description"] = payload.description
        node.properties = new_props
        flag_modified(node, "properties")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/process_map.py backend/app/api/v2/process_maps.py backend/tests/test_ai_edit.py
git commit -m "$(printf 'feat(sp5a): persist node description via NodeUpdate (no migration)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: Apply-step endpoint — `ai_proposed` node + edge + links

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (add endpoint; ensure `ClaimLinkKind` imported)
- Test: `backend/tests/test_ai_edit.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_ai_edit.py`:

```python
from sqlalchemy import select as _select

from app.models.process import EdgeClaimLink, NodeClaimLink as _NCL, ProcessEdge, ProcessNode


def test_apply_proposed_step_creates_ai_proposed_node_and_links(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    lane_id = n1.lane_id

    result = pm_api.apply_proposed_step(
        project=project,
        model_id=version.model_id,
        version_id=version.id,
        payload=pm_api.AiProposedStepRequest(
            source_node_id=n1.id,
            name="Verify budget",
            type="task",
            lane_id=lane_id,
            x=400.0,
            relative_y=20.0,
            edge_label="if over $10k",
            cited_claim_ids=[claim.id, uuid4()],  # second id is bogus → ignored
        ),
        db=db,
    )

    new_node = db.get(ProcessNode, result.node.id)
    assert new_node.properties["ai_proposed"] is True
    assert new_node.properties["_lineage_id"] == str(new_node.id)
    # An edge from source -> new node exists.
    edge = db.scalars(
        _select(ProcessEdge).where(ProcessEdge.target_node_id == new_node.id)
    ).one()
    assert edge.source_node_id == n1.id
    # Exactly one ai_proposed claim link (real claim only).
    links = list(db.scalars(_select(_NCL).where(_NCL.node_id == new_node.id)).all())
    assert len(links) == 1
    assert links[0].claim_id == claim.id
    assert links[0].link_kind == "ai_proposed"


def test_deleting_proposed_node_cascades_edge(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    result = pm_api.apply_proposed_step(
        project=project,
        model_id=version.model_id,
        version_id=version.id,
        payload=pm_api.AiProposedStepRequest(
            source_node_id=n1.id, name="X", type="task", lane_id=n1.lane_id,
            x=400.0, relative_y=0.0, edge_label=None, cited_claim_ids=[],
        ),
        db=db,
    )
    new_id = result.node.id
    pm_api.delete_node(project=project, node_id=new_id, db=db)
    assert db.get(ProcessNode, new_id) is None
    assert db.scalars(_select(ProcessEdge).where(ProcessEdge.target_node_id == new_id)).first() is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`
Expected: FAIL — `AttributeError: ... has no attribute 'apply_proposed_step'`.

- [ ] **Step 3: Add the endpoint**

In `backend/app/api/v2/process_maps.py`, confirm `ClaimLinkKind` is imported from `app.enums` (it is used by other routes; if not in the import list at lines 14-20, add it). Add the response schema import to the existing `from app.schemas.process_map import (...)` block: `ProcessEdgeRead` (already present) and add a small inline response model near the endpoint:

```python
from pydantic import BaseModel as _BaseModel


class AiProposedStepResult(_BaseModel):
    node: ProcessNodeRead
    edge: ProcessEdgeRead


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/ai-proposed-step",
    response_model=AiProposedStepResult,
    status_code=status.HTTP_201_CREATED,
)
def apply_proposed_step(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    payload: AiProposedStepRequest,
    db: Annotated[Session, Depends(get_db)],
) -> AiProposedStepResult:
    """Accept a suggested next step: create one ai_proposed node downstream of
    the source, the connecting edge, and ai_proposed claim links for cited
    claims that really exist in this project. One transaction."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    source = db.get(ProcessNode, payload.source_node_id)
    if source is None or source.version_id != version.id:
        raise HTTPException(status_code=422, detail="source_node_id must be a node in this version")
    lane = db.get(ProcessLane, payload.lane_id)
    if lane is None or lane.version_id != version.id:
        raise HTTPException(status_code=422, detail="lane_id must reference a lane in this version")

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
    node.properties = {**node.properties, LINEAGE_KEY: str(node.id), "ai_proposed": True}
    flag_modified(node, "properties")

    edge = ProcessEdge(
        version_id=version.id,
        source_node_id=source.id,
        target_node_id=node.id,
        label=payload.edge_label or None,
    )
    db.add(edge)

    # Link only claims that genuinely belong to this project.
    if payload.cited_claim_ids:
        valid_ids = set(
            db.scalars(
                select(Claim.id).where(
                    Claim.id.in_(payload.cited_claim_ids),
                    Claim.project_id == project.id,
                )
            ).all()
        )
        for cid in valid_ids:
            db.add(
                NodeClaimLink(
                    node_id=node.id,
                    claim_id=cid,
                    link_kind=ClaimLinkKind.AI_PROPOSED.value,
                )
            )

    db.commit()
    db.refresh(node)
    db.refresh(edge)
    return AiProposedStepResult(
        node=ProcessNodeRead.model_validate(node),
        edge=ProcessEdgeRead.model_validate(edge),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`
Expected: PASS (ai_proposed node + 1 real claim link; delete cascades the edge).

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && .venv/bin/pytest -q`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_ai_edit.py
git commit -m "$(printf 'feat(sp5a): apply-proposed-step endpoint (ai_proposed node+edge+links)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: Frontend types + API client

**Files:**
- Modify: `src/lib/types.ts` (`NodeUpdate.description`; AI-edit types)
- Modify: `src/lib/api.ts` (`aiEditNode`, `applyProposedStep`)

- [ ] **Step 1: Add types**

In `src/lib/types.ts`, add `description?: string;` to `NodeUpdate` (after `relative_y?`), and add these interfaces near the other process types:

```typescript
export type AiEditAction = "relabel" | "describe" | "validate" | "suggest_next";

export interface RelabelProposal {
  proposed_name: string;
  unchanged: boolean;
  rationale: string;
  cited_claim_ids: UUID[];
}

export interface DescribeProposal {
  proposed_description: string;
  rationale: string;
  cited_claim_ids: UUID[];
}

export interface ValidateGap {
  summary: string;
  severity: "low" | "medium" | "high";
  cited_claim_ids: UUID[];
}

export interface ValidateProposal {
  gaps: ValidateGap[];
}

export interface SuggestedStep {
  proposed_name: string;
  proposed_type: string;
  edge_label: string | null;
  rationale: string;
  cited_claim_ids: UUID[];
}

export interface SuggestNextProposal {
  steps: SuggestedStep[];
}

export interface AiEditResponse {
  action: AiEditAction;
  relabel?: RelabelProposal | null;
  describe?: DescribeProposal | null;
  validate?: ValidateProposal | null;
  suggest_next?: SuggestNextProposal | null;
}

export interface AiProposedStepRequest {
  source_node_id: UUID;
  name: string;
  type: string;
  lane_id: UUID;
  x: number;
  relative_y: number;
  edge_label?: string | null;
  cited_claim_ids: UUID[];
}

export interface AiProposedStepResult {
  node: ProcessNode;
  edge: ProcessEdge;
}
```

- [ ] **Step 2: Add API client functions**

In `src/lib/api.ts`, add to the `api` object (near `chatWithMap`):

```typescript
  aiEditNode: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    nodeId: UUID,
    action: AiEditAction
  ) =>
    request<AiEditResponse>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/nodes/${nodeId}/ai-edit`,
      { method: "POST", json: { action } }
    ),
  applyProposedStep: (
    projectId: UUID,
    modelId: UUID,
    versionId: UUID,
    body: AiProposedStepRequest
  ) =>
    request<AiProposedStepResult>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/ai-proposed-step`,
      { method: "POST", json: body }
    ),
```

Add the new type names to the existing `import type { ... } from "@/lib/types"` block at the top of `api.ts`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "$(printf 'feat(sp5a): frontend AI-edit types + API client fns\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8: Pure helpers — placement + edge-proposed derivation

**Files:**
- Create: `src/components/canvas/ai-edit.ts`
- Test: `src/components/canvas/ai-edit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/ai-edit.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { isEdgeProposed, placeProposedStep } from "./ai-edit";

describe("placeProposedStep", () => {
  it("places the new step downstream (to the right) of the source", () => {
    const pos = placeProposedStep({ x: 100, relativeY: 30, w: 170 });
    expect(pos.x).toBe(100 + 170 + 80);
    expect(pos.relativeY).toBe(30);
  });

  it("accepts a custom gap", () => {
    expect(placeProposedStep({ x: 0, relativeY: 0, w: 100 }, 40).x).toBe(140);
  });
});

describe("isEdgeProposed", () => {
  it("is true when either endpoint is ai-proposed", () => {
    expect(isEdgeProposed({ aiProposed: false }, { aiProposed: true })).toBe(true);
    expect(isEdgeProposed({ aiProposed: true }, { aiProposed: false })).toBe(true);
  });
  it("is false when neither endpoint is ai-proposed", () => {
    expect(isEdgeProposed({ aiProposed: false }, { aiProposed: false })).toBe(false);
    expect(isEdgeProposed(undefined, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/canvas/ai-edit.test.ts`
Expected: FAIL — cannot resolve `./ai-edit`.

- [ ] **Step 3: Write the helpers**

Create `src/components/canvas/ai-edit.ts`:

```typescript
/** Pure helpers for the AI edit-this-step feature (SP-5a). */

/** Where to drop a suggested next step: one node-width + a gap to the right of
 * the source, at the same vertical offset (the canvas auto-routes the edge). */
export function placeProposedStep(
  source: { x: number; relativeY: number; w: number },
  gap = 80
): { x: number; relativeY: number } {
  return { x: source.x + source.w + gap, relativeY: source.relativeY };
}

/** An edge is styled as AI-proposed when either endpoint is an AI-proposed
 * node (edges carry no flag of their own — see ProcessEdge). */
export function isEdgeProposed(
  from: { aiProposed?: boolean } | undefined,
  to: { aiProposed?: boolean } | undefined
): boolean {
  return Boolean(from?.aiProposed || to?.aiProposed);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/canvas/ai-edit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/ai-edit.ts src/components/canvas/ai-edit.test.ts
git commit -m "$(printf 'feat(sp5a): pure helpers for step placement + edge-proposed styling\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 9: Thread `aiProposed` + `description` through canvas state

**Files:**
- Modify: `src/components/canvas/types.ts` (`CanvasNode`)
- Modify: `src/components/canvas/layout.ts:120-131` (`buildCanvasState` node map)
- Test: `src/components/canvas/layout.test.ts` (create or extend)

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/layout.test.ts` (or extend if it exists):

```typescript
import { describe, expect, it } from "vitest";

import { buildCanvasState } from "./layout";
import type { ProcessGraph } from "@/lib/types";

function graphWith(props: Record<string, unknown>): ProcessGraph {
  return {
    version: { id: "v", model_id: "m", version_number: 1, status: "draft" } as never,
    lanes: [
      { id: "L", name: "Ops", order_index: 0, height_px: 200, collapsed: false } as never,
    ],
    nodes: [
      {
        id: "N",
        type: "task",
        name: "Step",
        lane_id: "L",
        position: { x: 10, relative_y: 5 },
        properties: props,
      } as never,
    ],
    edges: [],
  };
}

describe("buildCanvasState ai_proposed + description", () => {
  it("maps properties.ai_proposed and properties.description onto the node", () => {
    const { nodes } = buildCanvasState(
      graphWith({ ai_proposed: true, description: "does a thing" })
    );
    expect(nodes[0].aiProposed).toBe(true);
    expect(nodes[0].description).toBe("does a thing");
  });

  it("defaults aiProposed to false and description to undefined", () => {
    const { nodes } = buildCanvasState(graphWith({}));
    expect(nodes[0].aiProposed).toBe(false);
    expect(nodes[0].description).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/canvas/layout.test.ts`
Expected: FAIL — `aiProposed`/`description` are `undefined`/missing on `CanvasNode`.

- [ ] **Step 3: Extend `CanvasNode` and the mapper**

In `src/components/canvas/types.ts`, add to the `CanvasNode` interface (after `h: number;`):

```typescript
  /** True when this node was created by an AI proposal (properties.ai_proposed).
   * Drives distinct rendering. */
  aiProposed?: boolean;
  /** Optional free-text description (properties.description). */
  description?: string;
```

In `src/components/canvas/layout.ts`, in the `graph.nodes.map(...)` return object (after `h: size.h,`), add:

```typescript
      aiProposed: (n.properties as { ai_proposed?: boolean } | null)?.ai_proposed === true,
      description: (n.properties as { description?: string } | null)?.description,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/canvas/layout.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/types.ts src/components/canvas/layout.ts src/components/canvas/layout.test.ts
git commit -m "$(printf 'feat(sp5a): carry ai_proposed + description onto CanvasNode\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 10: Distinct rendering for `ai_proposed` nodes + edges

`ResolvedNode = Omit<CanvasNode, "relativeY"> & { y }`, so `aiProposed` already flows to `NodeShape`. `EdgeArrow` receives `nodes` and looks up endpoints, so it can derive the proposed style via `isEdgeProposed`.

**Files:**
- Modify: `src/components/canvas/shapes.tsx` (`NodeShape:180-257`, `EdgeArrow`)

- [ ] **Step 1: Add proposed styling to `NodeShape`**

In `src/components/canvas/shapes.tsx`, inside `NodeShape`, after the `const fill = "#ffffff";` line, add:

```typescript
  const proposed = node.aiProposed === true;
  const proposedStroke = "#7c3aed"; // violet — distinct from grounded steps
```

Then change the three shape strokes to prefer the proposed color when not selected/issue:
- Event `circle`: where `stroke={kind === "start" ? ... : "#475569"}`, wrap so a non-selected proposed node uses `proposedStroke`. Concretely set a computed `const baseStroke = proposed && !selected && !issueStroke ? proposedStroke : stroke;` right after the `proposedStroke` line, and use `baseStroke` for the gateway `polygon` and task `rect` `stroke=` props (lines ~232 and ~255). For the event circle, OR `proposedStroke` into its color expression when `proposed && !selected`.
- Add `strokeDasharray={proposed ? "5 3" : undefined}` to the task `rect` and gateway `polygon`.

Then add a sparkle marker for proposed task nodes — inside the `isTask` block, after the `<rect ... />`, add:

```tsx
          {proposed && (
            <text x={w - 12} y={14} fontSize="11" fill={proposedStroke} aria-label="AI proposed">
              ✦
            </text>
          )}
```

- [ ] **Step 2: Add proposed styling to `EdgeArrow`**

At the top of `EdgeArrow` (after it resolves its `from`/`to` nodes from `nodes`), add:

```tsx
  const proposed = isEdgeProposed(from, to);
```

(import `isEdgeProposed` from `./ai-edit` at the top of the file). On the edge's main `<path>`, add `stroke={proposed ? "#7c3aed" : <existing>}` and `strokeDasharray={proposed ? "5 3" : <existing>}` (preserve any existing dash for selected/preview states; proposed takes precedence only when not selected).

- [ ] **Step 3: Type-check + run canvas tests**

Run: `npx tsc --noEmit && npm test -- src/components/canvas`
Expected: PASS (existing canvas tests still green; no behavioral test added here — visual change verified in live smoke).

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/shapes.tsx
git commit -m "$(printf 'feat(sp5a): render ai_proposed nodes/edges distinctly (violet dashed + sparkle)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 11: Canvas handle — `description` update + `addProposedStep`

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx` (handle interface, `updateNodeImpl`, `applyNodeEditLocal`, imperative handle, selection)

- [ ] **Step 1: Extend the handle interface + selection**

In `src/components/canvas/bpmn-canvas.tsx`:
- In `CanvasSelection` (line 131), add `description?: string` to the `node` variant.
- In `BpmnCanvasHandle.updateNode` (line 141-144), change the patch type to:

```typescript
  updateNode: (
    id: UUID,
    patch: { name?: string; laneId?: UUID; type?: string; description?: string }
  ) => Promise<void>;
```

- Add to `BpmnCanvasHandle`:

```typescript
  /** Insert an AI-proposed downstream step (node + edge) returned by the
   * apply endpoint, select it, and record an undo entry. */
  addProposedStep: (args: {
    sourceId: UUID;
    name: string;
    type: string;
    citedClaimIds: UUID[];
    edgeLabel?: string | null;
  }) => Promise<void>;
```

- [ ] **Step 2: Handle `description` in `updateNodeImpl`**

In `applyNodeEditLocal` (line 253), extend the local-state update and the PATCH to carry an optional description. Change its signature/body to:

```typescript
  const applyNodeEditLocal = useCallback(
    async (
      id: UUID,
      next: { name: string; laneId: UUID | null; relativeY: number; description?: string }
    ) => {
      setNodes((curr) =>
        curr.map((n) =>
          n.id === id
            ? {
                ...n,
                label: next.name,
                laneId: next.laneId,
                relativeY: next.relativeY,
                ...(next.description !== undefined ? { description: next.description } : {}),
              }
            : n
        )
      );
      await api.updateNode(projectId, id, {
        name: next.name,
        lane_id: next.laneId ?? undefined,
        relative_y: next.relativeY,
        ...(next.description !== undefined ? { description: next.description } : {}),
      });
    },
    [projectId]
  );
```

In `updateNodeImpl` (line 295), add a description-only branch before the name/lane logic (after the `type` branch, ~line 312):

```typescript
      if (
        patch.description !== undefined &&
        patch.name === undefined &&
        patch.laneId === undefined
      ) {
        const oldDescription = old.description;
        const newDescription = patch.description;
        const base = { name: old.label, laneId: old.laneId, relativeY: old.relativeY };
        await applyNodeEditLocal(id, { ...base, description: newDescription });
        record({
          description: "Edit description",
          do: () => applyNodeEditLocal(id, { ...base, description: newDescription }),
          undo: () => applyNodeEditLocal(id, { ...base, description: oldDescription }),
        });
        return;
      }
```

Also update the `updateNodeImpl` parameter type to include `description?: string`.

- [ ] **Step 3: Implement `addProposedStep`**

Add this callback near `updateNodeImpl` (it uses `modelId`/`versionId`/`projectId` props, `setNodes`/`setEdges`, `selectOnly`, `record`, `deleteNodeImpl`, and `nodesRef`):

```typescript
  const addProposedStep = useCallback(
    async (args: {
      sourceId: UUID;
      name: string;
      type: string;
      citedClaimIds: UUID[];
      edgeLabel?: string | null;
    }) => {
      const source = nodesRef.current.find((n) => n.id === args.sourceId);
      if (!source) return;
      const lane = source.laneId;
      if (!lane) {
        toast.error("Can't place a step from a node with no lane.");
        return;
      }
      const { placeProposedStep } = await import("./ai-edit");
      const pos = placeProposedStep({ x: source.x, relativeY: source.relativeY, w: source.w });
      try {
        const res = await api.applyProposedStep(projectId, modelId, versionId, {
          source_node_id: args.sourceId,
          name: args.name,
          type: args.type,
          lane_id: lane,
          x: pos.x,
          relative_y: pos.relativeY,
          edge_label: args.edgeLabel ?? null,
          cited_claim_ids: args.citedClaimIds,
        });
        const size = sizeForNodeType(res.node.type);
        const newNode: CanvasNode = {
          id: res.node.id,
          type: res.node.type,
          kind: nodeKindFromType(res.node.type),
          label: res.node.name,
          laneId: lane,
          x: pos.x,
          relativeY: pos.relativeY,
          w: size.w,
          h: size.h,
          aiProposed: true,
        };
        const newEdge: CanvasEdge = {
          id: res.edge.id,
          from: res.edge.source_node_id,
          to: res.edge.target_node_id,
          label: res.edge.label,
        };
        setNodes((curr) => [...curr, newNode]);
        setEdges((curr) => [...curr, newEdge]);
        selectOnly(newNode.id);
        // Genuine undo/redo. `undo` deletes via the API (local + edge cascade);
        // `redo` re-creates through the apply endpoint and refreshes the
        // captured ids (a fresh row each time) so a later undo still targets
        // live rows rather than the deleted ones.
        let liveNode = newNode;
        let liveEdge = newEdge;
        const stepBody = {
          source_node_id: args.sourceId,
          name: args.name,
          type: args.type,
          lane_id: lane,
          x: pos.x,
          relative_y: pos.relativeY,
          edge_label: args.edgeLabel ?? null,
          cited_claim_ids: args.citedClaimIds,
        };
        record({
          description: "Add AI-proposed step",
          do: async () => {
            const again = await api.applyProposedStep(projectId, modelId, versionId, stepBody);
            liveNode = { ...newNode, id: again.node.id };
            liveEdge = {
              id: again.edge.id,
              from: again.edge.source_node_id,
              to: again.edge.target_node_id,
              label: again.edge.label,
            };
            setNodes((curr) => [...curr, liveNode]);
            setEdges((curr) => [...curr, liveEdge]);
            selectOnly(liveNode.id);
          },
          undo: () => deleteNodeImpl(liveNode.id),
        });
      } catch (err) {
        console.error("Failed to apply proposed step", err);
        toast.error("Couldn't add the suggested step — please try again.");
      }
    },
    [projectId, modelId, versionId, record, deleteNodeImpl]
  );
```

> Confirm `CanvasEdge`, `CanvasNode`, `sizeForNodeType`, `nodeKindFromType`, `toast`, and `deleteNodeImpl` are already imported/defined in this file (they are used elsewhere — `sizeForNodeType` via `node-type`, `nodeKindFromType` via `layout`). Add imports only if missing.

- [ ] **Step 4: Register both on the imperative handle**

In the `useImperativeHandle` object (line 487+), `updateNode: updateNodeImpl` already exists; add `addProposedStep,` to the returned object.

- [ ] **Step 5: Carry `aiProposed`/`description` into `renderNodes` + selection**

- `renderNodes` (line 675) maps `nodes` → `ResolvedNode`; since it spreads the node, `aiProposed` flows through automatically — verify the mapping spreads `...n` (if it lists fields explicitly, add `aiProposed: n.aiProposed`).
- Where the canvas emits the node selection (`onSelectionChange` with a `{ kind: "node", ... }`), include `description: node.description` so the Properties panel can show it. Find the `selectOnly`/selection-build site and add `description`.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx
git commit -m "$(printf 'feat(sp5a): canvas handle for description edits + addProposedStep\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 12: `AiEditPanel` — action menu + proposal cards

**Files:**
- Create: `src/components/canvas/ai-edit-panel.tsx`
- Test: `src/components/canvas/ai-edit-panel.test.tsx`

The panel owns the propose call + card state. It is given callbacks for each apply path so it stays decoupled from the canvas.

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/ai-edit-panel.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiEditPanel } from "./ai-edit-panel";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: { aiEditNode: vi.fn() },
}));

const baseProps = {
  projectId: "p" as never,
  modelId: "m" as never,
  versionId: "v" as never,
  nodeId: "n" as never,
  onRelabel: vi.fn(),
  onDescribe: vi.fn(),
  onAddStep: vi.fn(),
};

describe("AiEditPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs relabel and applies on Accept", async () => {
    (api.aiEditNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      action: "relabel",
      relabel: { proposed_name: "Receive PO", unchanged: false, rationale: "C1.", cited_claim_ids: ["c1"] },
    });
    render(<AiEditPanel {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /ask ai/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /relabel/i }));
    await waitFor(() => screen.getByText("Receive PO"));
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    expect(baseProps.onRelabel).toHaveBeenCalledWith("Receive PO");
  });

  it("dismisses a card on Reject without applying", async () => {
    (api.aiEditNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      action: "describe",
      describe: { proposed_description: "Logs the order.", rationale: "C1.", cited_claim_ids: [] },
    });
    render(<AiEditPanel {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /ask ai/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /describe/i }));
    await waitFor(() => screen.getByText("Logs the order."));
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(baseProps.onDescribe).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Logs the order.")).toBeNull());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/canvas/ai-edit-panel.test.tsx`
Expected: FAIL — cannot resolve `./ai-edit-panel`.

- [ ] **Step 3: Write the component**

Create `src/components/canvas/ai-edit-panel.tsx`:

```tsx
"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";

import { api } from "@/lib/api";
import type {
  AiEditAction,
  AiEditResponse,
  SuggestedStep,
  UUID,
} from "@/lib/types";

const ACTIONS: { action: AiEditAction; label: string }[] = [
  { action: "relabel", label: "Relabel step" },
  { action: "describe", label: "Describe step" },
  { action: "validate", label: "Validate completeness" },
  { action: "suggest_next", label: "Suggest next step" },
];

export function AiEditPanel({
  projectId,
  modelId,
  versionId,
  nodeId,
  onRelabel,
  onDescribe,
  onAddStep,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  nodeId: UUID;
  onRelabel: (name: string) => void;
  onDescribe: (description: string) => void;
  onAddStep: (step: SuggestedStep) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState<AiEditAction | null>(null);
  const [result, setResult] = useState<AiEditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: AiEditAction) {
    setMenuOpen(false);
    setResult(null);
    setError(null);
    setLoading(action);
    try {
      const res = await api.aiEditNode(projectId, modelId, versionId, nodeId, action);
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

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
          {ACTIONS.map((a) => (
            <button
              key={a.action}
              role="menuitem"
              type="button"
              onClick={() => run(a.action)}
              className="block w-full px-3 py-1.5 text-left text-[11px] text-slate-700 hover:bg-slate-50"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <p className="mt-2 text-[11px] text-slate-500">Asking Claude…</p>
      )}
      {error && (
        <p className="mt-2 text-[11px] text-rose-600">{error}</p>
      )}

      {result && (
        <ProposalCards
          result={result}
          onRelabel={(name) => { onRelabel(name); setResult(null); }}
          onDescribe={(d) => { onDescribe(d); setResult(null); }}
          onAddStep={(s) => { onAddStep(s); setResult(null); }}
          onDismiss={() => setResult(null)}
        />
      )}
    </div>
  );
}

function ClaimChips({ ids }: { ids: UUID[] }) {
  if (ids.length === 0) {
    return <span className="text-[10px] italic text-amber-700">no sourced claims — inference</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <span key={id} className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-mono text-slate-600">
          {id.slice(0, 8)}
        </span>
      ))}
    </div>
  );
}

function Card({
  title,
  rationale,
  citedIds,
  children,
}: {
  title: string;
  rationale: string;
  citedIds: UUID[];
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50/60 p-2">
      <p className="text-[11px] font-semibold text-slate-800">{title}</p>
      {rationale && <p className="mt-0.5 text-[10px] text-slate-500">{rationale}</p>}
      <div className="mt-1"><ClaimChips ids={citedIds} /></div>
      {children}
    </div>
  );
}

function AcceptReject({ onAccept, onReject }: { onAccept: () => void; onReject: () => void }) {
  return (
    <div className="mt-2 flex gap-1.5">
      <button type="button" onClick={onAccept} className="rounded bg-slate-800 px-2 py-1 text-[10px] font-semibold text-white">Accept</button>
      <button type="button" onClick={onReject} className="rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-600">Reject</button>
    </div>
  );
}

function ProposalCards({
  result,
  onRelabel,
  onDescribe,
  onAddStep,
  onDismiss,
}: {
  result: AiEditResponse;
  onRelabel: (name: string) => void;
  onDescribe: (description: string) => void;
  onAddStep: (step: SuggestedStep) => void;
  onDismiss: () => void;
}) {
  if (result.relabel) {
    const r = result.relabel;
    if (r.unchanged) {
      return <Card title="Label already faithful" rationale={r.rationale} citedIds={r.cited_claim_ids} />;
    }
    return (
      <Card title={r.proposed_name} rationale={r.rationale} citedIds={r.cited_claim_ids}>
        <AcceptReject onAccept={() => onRelabel(r.proposed_name)} onReject={onDismiss} />
      </Card>
    );
  }
  if (result.describe) {
    const d = result.describe;
    return (
      <Card title={d.proposed_description} rationale={d.rationale} citedIds={d.cited_claim_ids}>
        <AcceptReject onAccept={() => onDescribe(d.proposed_description)} onReject={onDismiss} />
      </Card>
    );
  }
  if (result.validate) {
    const gaps = result.validate.gaps;
    if (gaps.length === 0) {
      return <p className="mt-2 text-[11px] text-emerald-700">No completeness gaps found.</p>;
    }
    return (
      <div>
        {gaps.map((g, i) => (
          <Card key={i} title={`${g.severity.toUpperCase()}: ${g.summary}`} rationale="" citedIds={g.cited_claim_ids} />
        ))}
      </div>
    );
  }
  if (result.suggest_next) {
    const steps = result.suggest_next.steps;
    if (steps.length === 0) {
      return <p className="mt-2 text-[11px] text-slate-500">The sources don&apos;t support a next step.</p>;
    }
    return (
      <div>
        {steps.map((s, i) => (
          <Card key={i} title={`${s.proposed_name} (${s.proposed_type})`} rationale={s.rationale} citedIds={s.cited_claim_ids}>
            <AcceptReject onAccept={() => onAddStep(s)} onReject={onDismiss} />
          </Card>
        ))}
      </div>
    );
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/canvas/ai-edit-panel.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/ai-edit-panel.tsx src/components/canvas/ai-edit-panel.test.tsx
git commit -m "$(printf 'feat(sp5a): AiEditPanel — action menu + accept/reject proposal cards\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 13: Wire into Properties panel + page

**Files:**
- Modify: `src/components/canvas/properties-panel.tsx` (props, Description field, mount panel, replace dead button)
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` (pass modelId/versionId; description in patch; addProposedStep)

- [ ] **Step 1: Extend PropertiesPanel props + selection shape**

In `properties-panel.tsx`:
- Add `modelId: UUID;` and `versionId: UUID;` to the component props.
- Extend `SelectedNode` (line 24) with `description?: string;`.
- Extend the `onUpdate` patch type (line 50-53) with `description?: string`.

- [ ] **Step 2: Add a Description field**

After the Type/Lane grid (`</div>` at line 235), before the AI button, add a Description textarea bound to `selected.description`, committing on blur via `onUpdate`:

```tsx
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Description
          </label>
          <textarea
            value={descriptionDraft}
            onChange={(e) => setDescriptionDraft(e.target.value)}
            onBlur={() => {
              if (descriptionDraft !== (selected.description ?? "")) {
                onUpdate?.(selected.id, { description: descriptionDraft });
              }
            }}
            disabled={!onUpdate}
            rows={3}
            className="mt-1 w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-slate-500 focus:outline-none disabled:bg-slate-50"
          />
        </div>
```

Add the draft state near `labelDraft` (line 88):

```tsx
  const [descriptionDraft, setDescriptionDraft] = useState(selected.description ?? "");
  useEffect(() => {
    setDescriptionDraft(selected.description ?? "");
  }, [selected.id, selected.description]);
```

- [ ] **Step 3: Replace the dead button with `<AiEditPanel>`**

Replace the disabled button block (lines 237-244) with:

```tsx
        <AiEditPanel
          projectId={projectId}
          modelId={modelId}
          versionId={versionId}
          nodeId={selected.id}
          onRelabel={(name) => onUpdate?.(selected.id, { name })}
          onDescribe={(description) => {
            setDescriptionDraft(description);
            onUpdate?.(selected.id, { description });
          }}
          onAddStep={(step) => onAddStep?.(selected.id, step)}
        />
```

Add `onAddStep?: (sourceId: UUID, step: SuggestedStep) => void;` to the props, import `AiEditPanel` from `./ai-edit-panel`, and import `SuggestedStep` from `@/lib/types`. (Relabel reuses the existing `onUpdate` name path; Describe reuses the new description path.)

- [ ] **Step 4: Wire the page**

In `versions/[versionId]/page.tsx`:
- In `handleNodeUpdate` (line 87-104), widen the patch type to include `description?: string`, and add `...(patch.description !== undefined ? { description: patch.description } : {})` to the `setSelected` merge so the panel reflects it.
- Add an `onAddStep` handler:

```tsx
  const handleAddStep = useCallback(
    async (sourceId: UUID, step: { proposed_name: string; proposed_type: string; edge_label: string | null; cited_claim_ids: UUID[] }) => {
      await canvasRef.current?.addProposedStep({
        sourceId,
        name: step.proposed_name,
        type: step.proposed_type,
        citedClaimIds: step.cited_claim_ids,
        edgeLabel: step.edge_label,
      });
    },
    []
  );
```

- On `<PropertiesPanel>` (line 330), pass `modelId={params.modelId}`, `versionId={params.versionId}`, and `onAddStep={handleAddStep}`.
- The page already passes `selected={selectedNode}`; ensure `selectedNode` carries `description` (it comes from `CanvasSelection.node.description` set in Task 11 Step 5).

- [ ] **Step 5: Type-check + run frontend tests**

Run: `npx tsc --noEmit && npm test -- src/components/canvas`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/properties-panel.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "$(printf 'feat(sp5a): wire AI-edit menu + description into Properties panel\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 14: Full verification + live-smoke checklist

**Files:**
- Modify: `docs/superpowers/plans/2026-06-01-sp5a-ai-edit-step.md` (append an "Execution outcome" section)

- [ ] **Step 1: Backend gate**

Run: `cd backend && .venv/bin/pytest -q`
Expected: PASS (all tests including the new `test_ai_edit.py` / `test_map_context.py`).

- [ ] **Step 2: Frontend gates**

Run: `npx tsc --noEmit`
Expected: PASS.
Run: `npm test`
Expected: PASS (Vitest suite green, including the new ai-edit tests).

- [ ] **Step 3: Live smoke (best-effort — requires a real key)**

If `backend/.env` has a real `ANTHROPIC_API_KEY`, bring the stack up (`./run-local.sh status`; start if needed) and on a real node:
1. Open a map → select a task node → "Ask AI to edit this step".
2. **Relabel** → Accept → label changes; Cmd+Z reverts.
3. **Describe** → Accept → Description field fills; Cmd+Z reverts.
4. **Validate completeness** → read-only gap cards (or "no gaps").
5. **Suggest next step** → Accept → a violet, dashed, ✦-badged node appears downstream with a proposed edge; Cmd+Z deletes it.
6. Confirm a node with no cited claims shows the "inference" note and still renders distinct.

If the key is blank, record that the propose endpoint returns 502 by design and the live smoke is deferred — the structured/apply paths are covered by automated tests.

- [ ] **Step 4: Record the outcome + commit**

Append an "## Execution outcome" section to this plan documenting: gate results (pytest/tsc/vitest counts), live-smoke result or deferral, any deviations from the plan, and follow-ups. Commit:

```bash
git add docs/superpowers/plans/2026-06-01-sp5a-ai-edit-step.md
git commit -m "$(printf 'docs(sp5a): record AI-edit execution outcome\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-review notes (resolved during planning)

- **Spec coverage:** all four actions (relabel/describe/validate/suggest-next) have propose + apply paths (Tasks 4-6, 12-13); provenance marking via node flag + ai_proposed links + inherited edge styling (Tasks 6, 10); citation hygiene (Task 4); no migration — description/ai_proposed in `properties` JSONB (Tasks 5-6, 9); decompose explicitly excluded (no menu entry — SP-5b).
- **Type consistency:** the model returns `cited_claim_refs` (short strings); the endpoint resolves to `cited_claim_ids` (UUIDs) — names kept distinct on purpose. Frontend `AiEditResponse` uses `validate?` (no Python alias leakage; the backend response model serializes the `validate_` field under alias `validate`).
- **Risk — chat refactor (Task 1):** the extraction preserves the edge-selection label path; chat has no unit test, so Step 6 imports the module and runs the full suite to catch regressions.
- **Risk — `addProposedStep` undo/redo:** undo calls `deleteNodeImpl` (API + local removal + edge cascade), matching the backend cascade test (Task 6). Because undo deletes the backend rows, redo must re-create them: the callback re-POSTs through the apply endpoint and refreshes the captured `liveNode`/`liveEdge` ids so a subsequent undo targets the live rows, not the deleted ones. This is genuinely replayable (re-POST on redo is intentional for an AI insertion).
- **Edge styling precedence:** proposed styling applies only when the edge is not selected/in a drag-preview, so it never masks interaction states.

---

## Execution outcome (2026-06-01)

Executed via `superpowers:subagent-driven-development` — fresh implementer + spec-compliance + code-quality review per task, then a final holistic review (Opus) over the whole feature. Branch `sp5a-ai-edit-step` (off `sp4-version-control`).

### Gates (final, clean tree at the tip)
- Backend `pytest`: **95 passed** (baseline 76 + new `test_ai_edit.py` 17 + `test_map_context.py` 2).
- `npx tsc --noEmit`: **clean**.
- Frontend `npm test` (Vitest): **36 passed** (added `ai-edit.test.ts`, `layout.test.ts`).

### Live smoke (real `ANTHROPIC_API_KEY`, real dev DB, project Test2 → "Project Closeout, Punch List & Warranty" L2)
All exercised against the hot-reloaded local stack and **cleaned up** (no residue):
- **relabel / describe / validate / suggest_next** propose calls each returned grounded, claim-cited structured proposals (e.g. validate surfaced 6 gaps; suggest_next returned 3 steps incl. a `gateway_exclusive`).
- **apply-proposed-step**: created a node with `properties.ai_proposed = True` + `_lineage_id`, an edge source→new node, and exactly 3 `ai_proposed` `NodeClaimLink`s (matching the 3 cited claims). Deleting the node cascaded the edge + links; node/edge counts restored exactly (29/32). Dev DB left untouched.

### Notable decisions & deviations from the plan
- **No DOM component test for `AiEditPanel` (Task 12).** The project's Vitest is `environment: "node"`, `include: ["src/**/*.test.ts"]`, with no `@testing-library/react`/jsdom, and **no** existing canvas component has a component test — the established convention is pure-logic `.test.ts` + tsc + live smoke. Rather than bolt a DOM test stack onto the repo (unsanctioned scope, would be the only such test), `AiEditPanel` is a thin presentational component verified by tsc and the live smoke. The plan's `.test.tsx` was intentionally not created.
- **Task 1 model-field corrections:** the plan's seed used `organization_id`; the real fields are `org_id` (User/Project). Fixed in tests.
- **Claim-citation scope:** hygiene scopes citable refs to the **project's** claims (not only claims already attached to a node in this version) so a suggested next step can cite a real-but-unattached claim; the apply endpoint re-filters to project-scoped claims as a second guard. The design doc wording was corrected to match (it previously said "within this version").
- **Multi-step suggest_next UX (final-review fix):** accepting/rejecting one suggested step now removes only that card and leaves siblings pending, instead of clearing the whole result set.
- **Hardening from review:** propose endpoint catches `(RuntimeError, ValueError)` → 502 (a malformed/empty Anthropic response can't 500); explicit action dispatch with a 422 fallback; `addProposedStep` redo guarded against a failed re-POST; AI text fields length-bounded and `proposed_type`/`type` constrained to the `NodeType` set in the schemas.

### Deferred follow-ups (not blocking SP-5a)
- Claim chips in the proposal cards show truncated UUID prefixes; showing claim subject/kind (the existing citation style) would need the propose response to carry claim summaries. Acceptable for the first cut.
- `MAX_TOKENS = 1200` could truncate a very long `suggest_next`; truncation degrades to fewer/empty proposals (graceful), never a 500.
- **SP-5b** (separate brainstorm → spec → plan → stacked PR): decompose-to-next-level (child `ProcessModel` + cross-level navigation), deliberately out of scope here.
