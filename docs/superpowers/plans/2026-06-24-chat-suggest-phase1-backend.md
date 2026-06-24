# Chat-Suggest Phase 1: Backend Suggestion Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend for a Word-style AI chat that returns prose plus structured, applyable *suggested changes* spanning nodes, edges, and lanes — plus a deterministic whole-map consistency scan. No UI in this phase; everything is verified through API/service tests.

**Architecture:** One new agentic endpoint `POST .../chat-suggest`. In **ask** mode it reuses today's plain-text chat. In **suggest** mode the model is given a single optional `propose_changes` tool and replies with prose and/or a list of typed diff-ops; it calls the tool only when an edit is warranted. The endpoint resolves the model's short refs (`N1`, `E2`, `L1`, `C1`) to real UUIDs, drops fabricated claim refs and malformed ops, and returns `{ message, suggestions[] }`. A separate deterministic `scan_map` pure function detects structural problems (dangling edges, duplicate names, single-branch gateways, ownerless lanes, orphans).

**Tech Stack:** FastAPI, SQLAlchemy, Pydantic v2, the `anthropic` SDK, pytest. Mirrors the existing SP-5a per-node ai-edit feature (`map_ai_edit.py`, `version_ai_edit.py`, `test_ai_edit.py`).

---

## Context for the engineer

This is **Phase 1 of 4** in the chat-suggest rebuild (spec: `docs/superpowers/specs/2026-06-24-chat-suggest-rebuild-design.md`):

- **Phase 1 (this plan):** backend suggestion engine + consistency scan. Backend only.
- **Phase 2:** chat panel shell, Ask mode, selection chips, mentions-as-hyperlinks, teleport-to-object.
- **Phase 3:** suggestion cards, apply/undo, staleness, grouping/Apply-all, dimming.
- **Phase 4:** consistency-scan UX, remove the old per-node ai-edit panel, deletion impact-preview.

**Branch:** `chat-suggest-rebuild` (already based on `origin/main`).

**Dependency note — decompose:** The `decompose` op kind is included in the suggestion schema so the model *can* emit it, but the apply pipeline it targets (`applyDecompose`, SP-5b) is in the still-open PR #27 and is **not on `main`**. Applying a decompose suggestion is a Phase 3/4 concern that must wait for PR #27 to merge. Phase 1 only *emits* the suggestion, which is safe.

**Study these existing files before starting** — Phase 1 mirrors their patterns exactly:
- `backend/app/services/map_ai_edit.py` — forced-tool service, `_CITED`, `_NODE_TYPES`, `_get_client()`.
- `backend/app/services/map_chat.py` — `SYSTEM_PROMPT`, `ChatTurn`, `chat()`.
- `backend/app/services/map_context.py` — `assemble_map_context()`, `MapContext`.
- `backend/app/schemas/version_ai_edit.py` — schema conventions, `_NODE_TYPE_PATTERN`.
- `backend/app/api/v2/process_maps.py:1108-1248` — `chat_with_map`, `_resolve_refs`, `ai_edit_node`.
- `backend/tests/test_ai_edit.py` — `_FakeClient`, `_seed_version_for_endpoint`, `db` fixture usage.

**Running tests:** from `backend/`:
```bash
cd /home/ewise/projects/processreengineering/backend && pytest tests/<file>::<test> -v
```
`ANTHROPIC_API_KEY` is **not** required — every test fakes the Anthropic client or patches the service.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `backend/app/services/map_context.py` | Add node/edge/lane **ref→id** reverse maps to `MapContext` | Modify |
| `backend/app/schemas/version_chat_suggest.py` | `ChatMode`, `RefKind`, `OpKind`, `ObjectRef`, `SuggestionOp`, `ChatSuggestion`, request/response | Create |
| `backend/app/services/map_chat_suggest.py` | `propose_changes` tool + `run_chat_suggest()` (ask reuses `chat()`; suggest = optional tool call) | Create |
| `backend/app/services/map_consistency.py` | `scan_map()` pure structural detector | Create |
| `backend/app/api/v2/process_maps.py` | `chat_suggest` endpoint + ref-resolution helpers; `map_consistency` endpoint | Modify |
| `backend/tests/test_map_context.py` | reverse-map tests | Modify |
| `backend/tests/test_chat_suggest.py` | schema, service, endpoint, resolution tests | Create |
| `backend/tests/test_map_consistency.py` | detector fixtures | Create |

---

## Task 1: Add reverse ref maps to MapContext

The model emits short refs (`N1`, `E2`, `L1`). To resolve them to UUIDs the endpoint needs `ref → id` maps. `assemble_map_context` currently exposes only `node_ref_by_id` (id→ref) and `claim_ref_to_id`. Add inverse maps for nodes, edges, and lanes.

**Files:**
- Modify: `backend/app/services/map_context.py`
- Test: `backend/tests/test_map_context.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_map_context.py` (reuse the seeding style from `test_ai_edit.py`; if the file already has a seeding helper, use it instead of redefining):

```python
def test_assemble_map_context_exposes_reverse_ref_maps(db):
    from uuid import uuid4
    from app.models.identity import Organization, User
    from app.models.project import Project
    from app.models.process import (
        ProcessModel, ProcessVersion, ProcessLane, ProcessNode, ProcessEdge,
    )
    from app.services.map_context import assemble_map_context

    org = Organization(name="O"); db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U"); db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id); db.add(project); db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2"); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1); db.add(version); db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0); db.add(lane); db.flush()
    n1 = ProcessNode(version_id=version.id, lane_id=lane.id, type="task", name="A", position={}, properties={})
    n2 = ProcessNode(version_id=version.id, lane_id=lane.id, type="task", name="B", position={}, properties={})
    db.add_all([n1, n2]); db.flush()
    e1 = ProcessEdge(version_id=version.id, source_node_id=n1.id, target_node_id=n2.id, label="go")
    db.add(e1); db.commit()

    ctx = assemble_map_context(db, version)

    assert ctx.node_ref_to_id["N1"] == n1.id
    assert ctx.node_ref_to_id["N2"] == n2.id
    assert ctx.edge_ref_to_id["E1"] == e1.id
    assert ctx.lane_ref_to_id["L1"] == lane.id
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_map_context.py::test_assemble_map_context_exposes_reverse_ref_maps -v`
Expected: FAIL — `AttributeError: 'MapContext' object has no attribute 'node_ref_to_id'`.

- [ ] **Step 3: Implement**

In `backend/app/services/map_context.py`, extend the dataclass:

```python
@dataclass
class MapContext:
    text: str
    selected_label: str | None
    node_ref_by_id: dict[UUID, str]
    claim_ref_to_id: dict[str, UUID]
    node_ref_to_id: dict[str, UUID]
    edge_ref_to_id: dict[str, UUID]
    lane_ref_to_id: dict[str, UUID]
```

Build the inverse maps next to the existing `*_ref_by_id` dicts (the edge order must match the `E{idx}` rendering, which iterates `edges` in query order):

```python
    edge_ref_by_id: dict[UUID, str] = {e.id: f"E{i + 1}" for i, e in enumerate(edges)}
    node_ref_to_id = {ref: nid for nid, ref in node_ref_by_id.items()}
    edge_ref_to_id = {ref: eid for eid, ref in edge_ref_by_id.items()}
    lane_ref_to_id = {ref: lid for lid, ref in lane_ref_by_id.items()}
```

Return them:

```python
    return MapContext(
        text=text,
        selected_label=selected_label,
        node_ref_by_id=node_ref_by_id,
        claim_ref_to_id=claim_ref_to_id,
        node_ref_to_id=node_ref_to_id,
        edge_ref_to_id=edge_ref_to_id,
        lane_ref_to_id=lane_ref_to_id,
    )
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_map_context.py -v`
Expected: PASS (the new test and all existing `test_map_context.py` tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_context.py backend/tests/test_map_context.py
git commit -m "feat(chat-suggest): expose node/edge/lane ref->id maps on MapContext"
```

---

## Task 2: Suggestion schemas

One permissive `SuggestionOp` model (single `kind` discriminator + all-optional typed fields, validated per kind) keeps this DRY versus 12 separate classes. Op ref fields hold a **resolved object id (UUID as string) or a `tmp:N` placeholder** in the response; per-kind required-field validation guards against malformed model output.

**Files:**
- Create: `backend/app/schemas/version_chat_suggest.py`
- Test: `backend/tests/test_chat_suggest.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_chat_suggest.py`:

```python
"""Tests for the chat-suggest backend: schemas, service, endpoint, resolution."""
import pytest


def test_op_relabel_node_requires_node_ref_and_label():
    from app.schemas.version_chat_suggest import SuggestionOp, OpKind
    op = SuggestionOp(kind=OpKind.RELABEL_NODE, node_ref="N1", new_label="Receive PO")
    assert op.kind == OpKind.RELABEL_NODE
    with pytest.raises(ValueError):
        SuggestionOp(kind=OpKind.RELABEL_NODE, node_ref="N1")  # missing new_label


def test_op_add_node_requires_temp_id_lane_and_type():
    from app.schemas.version_chat_suggest import SuggestionOp, OpKind
    op = SuggestionOp(
        kind=OpKind.ADD_NODE, temp_id="tmp:1", lane_ref="L1",
        node_type="task", new_label="Verify budget",
    )
    assert op.temp_id == "tmp:1"
    with pytest.raises(ValueError):
        SuggestionOp(kind=OpKind.ADD_NODE, temp_id="tmp:1", lane_ref="L1", node_type="task")


def test_op_add_node_rejects_unknown_node_type():
    from app.schemas.version_chat_suggest import SuggestionOp, OpKind
    with pytest.raises(ValueError):
        SuggestionOp(kind=OpKind.ADD_NODE, temp_id="tmp:1", lane_ref="L1",
                     node_type="not_a_type", new_label="X")


def test_chat_suggest_request_defaults():
    from app.schemas.version_chat_suggest import ChatSuggestRequest, ChatMode
    req = ChatSuggestRequest(user_message="hi", mode="ask")
    assert req.mode == ChatMode.ASK
    assert req.history == []
    assert req.context_refs == []
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_chat_suggest.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.schemas.version_chat_suggest'`.

- [ ] **Step 3: Implement**

Create `backend/app/schemas/version_chat_suggest.py`:

```python
"""Schemas for the chat-suggest feature (Word-style suggested changes).

A response carries prose (`message`) plus a list of `ChatSuggestion`s. Each
suggestion wraps one typed `SuggestionOp`. Op ref fields hold a resolved object
id (UUID as string) or a `tmp:N` placeholder for an object created within the
same response (so a new edge can reference a new node). Per-kind required-field
validation drops malformed model output before it reaches the client.
"""
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from app.enums import NodeType

_NODE_TYPE_VALUES = {t.value for t in NodeType}


class ChatMode(StrEnum):
    ASK = "ask"
    SUGGEST = "suggest"


class RefKind(StrEnum):
    NODE = "node"
    EDGE = "edge"
    LANE = "lane"


class OpKind(StrEnum):
    RELABEL_NODE = "relabel_node"
    DESCRIBE_NODE = "describe_node"
    ADD_NODE = "add_node"
    REMOVE_NODE = "remove_node"
    ADD_EDGE = "add_edge"
    REMOVE_EDGE = "remove_edge"
    RELABEL_EDGE = "relabel_edge"
    REROUTE_EDGE = "reroute_edge"
    MOVE_TO_LANE = "move_to_lane"
    ADD_LANE = "add_lane"
    RENAME_LANE = "rename_lane"
    DECOMPOSE = "decompose"


# Per-kind required op fields. reroute_edge needs edge_ref plus at least one of
# from_ref/to_ref (checked separately below).
_REQUIRED_BY_KIND: dict[OpKind, tuple[str, ...]] = {
    OpKind.RELABEL_NODE: ("node_ref", "new_label"),
    OpKind.DESCRIBE_NODE: ("node_ref", "description"),
    OpKind.ADD_NODE: ("temp_id", "lane_ref", "node_type", "new_label"),
    OpKind.REMOVE_NODE: ("node_ref",),
    OpKind.ADD_EDGE: ("from_ref", "to_ref"),
    OpKind.REMOVE_EDGE: ("edge_ref",),
    OpKind.RELABEL_EDGE: ("edge_ref", "new_label"),
    OpKind.REROUTE_EDGE: ("edge_ref",),
    OpKind.MOVE_TO_LANE: ("node_ref", "lane_ref"),
    OpKind.ADD_LANE: ("temp_id", "name"),
    OpKind.RENAME_LANE: ("lane_ref", "name"),
    OpKind.DECOMPOSE: ("node_ref", "sub_steps"),
}


class SubStepInput(BaseModel):
    proposed_name: str = Field(min_length=1, max_length=500)
    proposed_type: str = "task"
    role: str | None = None
    edge_label: str | None = None


class SuggestionOp(BaseModel):
    kind: OpKind
    node_ref: str | None = None
    edge_ref: str | None = None
    lane_ref: str | None = None
    temp_id: str | None = None
    from_ref: str | None = None
    to_ref: str | None = None
    new_label: str | None = Field(default=None, max_length=500)
    description: str | None = Field(default=None, max_length=5000)
    name: str | None = Field(default=None, max_length=500)
    node_type: str | None = None
    near_node_ref: str | None = None
    edge_label: str | None = Field(default=None, max_length=300)
    sub_steps: list[SubStepInput] | None = None

    @model_validator(mode="after")
    def _check_required(self) -> "SuggestionOp":
        for field in _REQUIRED_BY_KIND[self.kind]:
            if getattr(self, field) in (None, "", []):
                raise ValueError(f"{self.kind} requires '{field}'")
        if self.node_type is not None and self.node_type not in _NODE_TYPE_VALUES:
            raise ValueError(f"unknown node_type '{self.node_type}'")
        if self.kind == OpKind.REROUTE_EDGE and not (self.from_ref or self.to_ref):
            raise ValueError("reroute_edge requires from_ref or to_ref")
        return self


class ObjectRef(BaseModel):
    kind: RefKind
    id: UUID


class ChatSuggestion(BaseModel):
    id: str
    group: str | None = None
    title: str = Field(min_length=1, max_length=300)
    op: SuggestionOp
    affected_refs: list[ObjectRef] = Field(default_factory=list)
    rationale: str = Field(default="", max_length=2000)
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class ChatTurn(BaseModel):
    role: str = Field(pattern=r"^(user|assistant)$")
    content: str = Field(min_length=1, max_length=20_000)


class ChatSuggestRequest(BaseModel):
    history: list[ChatTurn] = Field(default_factory=list, max_length=40)
    user_message: str = Field(min_length=1, max_length=4000)
    mode: ChatMode = ChatMode.SUGGEST
    context_refs: list[ObjectRef] = Field(default_factory=list)


class ChatSuggestResponse(BaseModel):
    message: str
    suggestions: list[ChatSuggestion] = Field(default_factory=list)
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_chat_suggest.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/version_chat_suggest.py backend/tests/test_chat_suggest.py
git commit -m "feat(chat-suggest): suggestion op + request/response schemas with per-kind validation"
```

---

## Task 3: Suggestion service (`map_chat_suggest.py`)

Ask mode reuses the existing `chat()`. Suggest mode binds one **optional** `propose_changes` tool so the model can reply with prose, a tool call, or both — emitting suggestions only when warranted.

**Files:**
- Create: `backend/app/services/map_chat_suggest.py`
- Test: `backend/tests/test_chat_suggest.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_chat_suggest.py`:

```python
from types import SimpleNamespace
from unittest.mock import patch


class _TextBlock:
    def __init__(self, text):
        self.type = "text"; self.text = text


class _ToolBlock:
    def __init__(self, name, payload):
        self.type = "tool_use"; self.name = name; self.input = payload


class _FakeClient:
    def __init__(self, blocks):
        self._blocks = blocks

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        return SimpleNamespace(content=self._blocks)


def test_suggest_mode_returns_message_and_raw_suggestions():
    from app.services import map_chat_suggest
    from app.schemas.version_chat_suggest import ChatMode
    fake = _FakeClient([
        _TextBlock("Here is one improvement."),
        _ToolBlock("propose_changes", {"suggestions": [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
             "title": "Clarify step name", "rationale": "C1 says so.",
             "cited_claim_refs": ["C1"]}]}),
    ])
    with patch.object(map_chat_suggest, "_get_client", return_value=fake):
        message, raw = map_chat_suggest.run_chat_suggest(
            history=[], user_message="improve N1", map_context_text="...",
            mode=ChatMode.SUGGEST,
        )
    assert "improvement" in message
    assert raw[0]["kind"] == "relabel_node"
    assert raw[0]["cited_claim_refs"] == ["C1"]


def test_suggest_mode_no_tool_call_returns_empty_suggestions():
    from app.services import map_chat_suggest
    from app.schemas.version_chat_suggest import ChatMode
    fake = _FakeClient([_TextBlock("That looks correct as-is; no change needed.")])
    with patch.object(map_chat_suggest, "_get_client", return_value=fake):
        message, raw = map_chat_suggest.run_chat_suggest(
            history=[], user_message="is N1 ok?", map_context_text="...",
            mode=ChatMode.SUGGEST,
        )
    assert raw == []
    assert "no change" in message.lower()


def test_ask_mode_never_calls_tools():
    from app.services import map_chat_suggest
    from app.schemas.version_chat_suggest import ChatMode
    captured = {}

    def fake_chat(*, history, user_message, map_context_text):
        captured["called"] = True
        return "A plain answer."

    with patch.object(map_chat_suggest, "chat", fake_chat):
        message, raw = map_chat_suggest.run_chat_suggest(
            history=[], user_message="what is N1?", map_context_text="...",
            mode=ChatMode.ASK,
        )
    assert captured["called"] is True
    assert raw == []
    assert message == "A plain answer."
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_chat_suggest.py -k "suggest_mode or ask_mode" -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.map_chat_suggest'`.

- [ ] **Step 3: Implement**

Create `backend/app/services/map_chat_suggest.py`:

```python
"""Agentic chat that returns prose plus structured suggested changes.

Ask mode reuses the plain-text chat. Suggest mode binds one optional
`propose_changes` tool: the model replies with prose, a tool call, or both,
emitting suggestions only when an edit is warranted. The service stays
I/O-free apart from the Anthropic call and returns RAW dicts; the endpoint
does ref resolution and per-kind validation.
"""
import os

import anthropic

from app.enums import NodeType
from app.schemas.version_chat_suggest import ChatMode, OpKind
from app.services.map_chat import SYSTEM_PROMPT as CHAT_GUARDRAILS, ChatTurn, chat

SUGGEST_MODEL = os.getenv("MAP_CHAT_SUGGEST_MODEL", os.getenv("MAP_CHAT_MODEL", "claude-sonnet-4-6"))
MAX_TOKENS = 2000

_NODE_TYPES = [t.value for t in NodeType]
_OP_KINDS = [k.value for k in OpKind]

SUGGEST_INSTRUCTIONS = """\
You may propose concrete edits to the map. Call `propose_changes` ONLY when the
sources or the map's structure actually warrant a change. A question, or a map
that is already correct, gets a prose reply and NO tool call.

Rules for suggestions:
- One suggestion per discrete change. Give each a short imperative `title`.
- Reference EXISTING objects by their short refs from the context: nodes N1/N2,
  edges E1/E2, lanes L1/L2. Reference NEW objects you introduce by temp ids like
  tmp:1, tmp:2 — so an add_edge can point `from_ref`/`to_ref` at a new node's
  temp_id.
- Group related changes by giving them the same `group` string.
- Justify each with `rationale` and `cited_claim_refs` (short claim refs C1, C2
  from the context; never invent one).
- Do not propose a deletion casually; only when the sources clearly contradict
  an object's existence.
"""

PROPOSE_TOOL = {
    "name": "propose_changes",
    "description": "Emit one or more suggested edits to the open process map.",
    "input_schema": {
        "type": "object",
        "properties": {
            "suggestions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": _OP_KINDS},
                        "title": {"type": "string"},
                        "rationale": {"type": "string"},
                        "group": {"type": ["string", "null"]},
                        "cited_claim_refs": {
                            "type": "array", "items": {"type": "string"},
                            "description": "Short claim refs (C1, C2) from the context. Never invent one.",
                        },
                        "node_ref": {"type": ["string", "null"]},
                        "edge_ref": {"type": ["string", "null"]},
                        "lane_ref": {"type": ["string", "null"]},
                        "temp_id": {"type": ["string", "null"]},
                        "from_ref": {"type": ["string", "null"]},
                        "to_ref": {"type": ["string", "null"]},
                        "new_label": {"type": ["string", "null"]},
                        "description": {"type": ["string", "null"]},
                        "name": {"type": ["string", "null"]},
                        "node_type": {"type": ["string", "null"], "enum": [*_NODE_TYPES, None]},
                        "near_node_ref": {"type": ["string", "null"]},
                        "edge_label": {"type": ["string", "null"]},
                        "sub_steps": {"type": ["array", "null"], "items": {"type": "object"}},
                    },
                    "required": ["kind", "title", "rationale"],
                },
            }
        },
        "required": ["suggestions"],
    },
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


def run_chat_suggest(
    *,
    history: list[ChatTurn],
    user_message: str,
    map_context_text: str,
    mode: ChatMode,
) -> tuple[str, list[dict]]:
    """Return (prose_message, raw_suggestion_dicts). Raw dicts use the model's
    short refs; the endpoint resolves and validates them."""
    if mode == ChatMode.ASK:
        message = chat(
            history=history,
            user_message=user_message,
            map_context_text=map_context_text,
        )
        return message, []

    system = (
        CHAT_GUARDRAILS
        + "\n\n---\n"
        + SUGGEST_INSTRUCTIONS
        + "\n\n---\nCurrent process map (grounded source of truth):\n"
        + map_context_text
    )
    messages = [{"role": t.role, "content": t.content} for t in history
                if t.role in ("user", "assistant")]
    messages.append({"role": "user", "content": user_message})

    client = _get_client()
    response = client.messages.create(
        model=SUGGEST_MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        tools=[PROPOSE_TOOL],
        messages=messages,
        timeout=90.0,
    )

    text_parts: list[str] = []
    raw_suggestions: list[dict] = []
    for block in response.content:
        if block.type == "text":
            text_parts.append(block.text)
        elif block.type == "tool_use" and block.name == "propose_changes":
            raw_suggestions.extend(dict(block.input).get("suggestions", []))
    return "".join(text_parts).strip(), raw_suggestions
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_chat_suggest.py -v`
Expected: PASS (all schema + service tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_chat_suggest.py backend/tests/test_chat_suggest.py
git commit -m "feat(chat-suggest): suggestion service with optional propose_changes tool"
```

---

## Task 4: Ref-resolution helpers

Translate the model's short refs into a validated `ChatSuggestion`: resolve op ref fields (`N1`→UUID string, leave `tmp:N` untouched), build `affected_refs` (real objects only), resolve claim refs, and drop malformed ops. These are pure helpers added to `process_maps.py` near the existing `_resolve_refs`.

**Files:**
- Modify: `backend/app/api/v2/process_maps.py`
- Test: `backend/tests/test_chat_suggest.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_chat_suggest.py`:

```python
def _ctx_stub():
    """A minimal object with the resolution maps the helpers read."""
    from uuid import uuid4
    n1, n2, e1, l1, c1 = uuid4(), uuid4(), uuid4(), uuid4(), uuid4()
    return SimpleNamespace(
        node_ref_to_id={"N1": n1, "N2": n2},
        edge_ref_to_id={"E1": e1},
        lane_ref_to_id={"L1": l1},
        claim_ref_to_id={"C1": c1},
    ), (n1, n2, e1, l1, c1)


def test_build_suggestion_resolves_node_ref_and_claims():
    from app.api.v2 import process_maps as pm_api
    ctx, (n1, _n2, _e1, _l1, c1) = _ctx_stub()
    raw = {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
           "title": "Clarify", "rationale": "C1 says so.",
           "cited_claim_refs": ["C1", "C99"]}
    s = pm_api._build_suggestion(raw, ctx, index=0)
    assert s.op.node_ref == str(n1)           # short ref resolved to UUID string
    assert s.cited_claim_ids == [c1]          # C99 dropped
    assert s.affected_refs[0].id == n1
    assert s.affected_refs[0].kind.value == "node"


def test_build_suggestion_keeps_temp_ids_for_new_objects():
    from app.api.v2 import process_maps as pm_api
    ctx, (n1, _n2, _e1, l1, _c1) = _ctx_stub()
    raw = {"kind": "add_node", "temp_id": "tmp:1", "lane_ref": "L1",
           "node_type": "task", "new_label": "Verify budget", "near_node_ref": "N1",
           "title": "Add budget check", "rationale": "needed", "cited_claim_refs": []}
    s = pm_api._build_suggestion(raw, ctx, index=0)
    assert s.op.temp_id == "tmp:1"            # temp id untouched
    assert s.op.lane_ref == str(l1)           # existing lane resolved
    assert s.op.near_node_ref == str(n1)
    # affected_refs holds only resolvable existing objects (the lane + near node)
    assert {r.id for r in s.affected_refs} == {l1, n1}


def test_build_suggestion_returns_none_for_malformed_op():
    from app.api.v2 import process_maps as pm_api
    ctx, _ = _ctx_stub()
    raw = {"kind": "relabel_node", "node_ref": "N1",  # missing new_label
           "title": "x", "rationale": "y", "cited_claim_refs": []}
    assert pm_api._build_suggestion(raw, ctx, index=0) is None
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_chat_suggest.py -k build_suggestion -v`
Expected: FAIL — `AttributeError: module ... has no attribute '_build_suggestion'`.

- [ ] **Step 3: Implement**

In `backend/app/api/v2/process_maps.py`, add imports near the other schema imports:

```python
from app.schemas.version_chat_suggest import (
    ChatMode,
    ChatSuggestRequest,
    ChatSuggestResponse,
    ChatSuggestion,
    ObjectRef,
    RefKind,
    SuggestionOp,
)
from app.services.map_chat_suggest import run_chat_suggest
from app.schemas.version_chat_suggest import ChatTurn as SuggestChatTurn
```

Add these helpers just below the existing `_resolve_refs` (around line 1169). The `_OP_REF_FIELDS` map says which op fields hold object refs and what kind each resolves to; `near_node_ref` resolves against nodes but is navigational context, included in `affected_refs`.

```python
# Op field -> (resolution map attname, RefKind). Fields not listed are literals.
_OP_REF_FIELDS: dict[str, tuple[str, RefKind]] = {
    "node_ref": ("node_ref_to_id", RefKind.NODE),
    "near_node_ref": ("node_ref_to_id", RefKind.NODE),
    "edge_ref": ("edge_ref_to_id", RefKind.EDGE),
    "lane_ref": ("lane_ref_to_id", RefKind.LANE),
    "from_ref": ("node_ref_to_id", RefKind.NODE),
    "to_ref": ("node_ref_to_id", RefKind.NODE),
    "temp_id": (None, None),  # never resolved; identifies a new object
}


def _resolve_one_ref(value, map_attr, ctx):
    """Short ref (N1) -> UUID string. tmp:N and unknown refs pass through unchanged."""
    if value is None or str(value).startswith("tmp:"):
        return value, None
    real = getattr(ctx, map_attr).get(str(value).strip())
    if real is None:
        return value, None  # leave unresolved; affected_refs will skip it
    return str(real), real


def _build_suggestion(raw: dict, ctx, index: int):
    """Resolve a raw model suggestion into a validated ChatSuggestion, or None
    if the op is malformed. Mirrors _resolve_refs' fabricated-ref hygiene."""
    import uuid as _uuid

    op_kwargs = {"kind": raw.get("kind")}
    affected: list[ObjectRef] = []
    for field, (map_attr, ref_kind) in _OP_REF_FIELDS.items():
        if field not in raw or raw[field] is None:
            continue
        if field == "temp_id":
            op_kwargs[field] = raw[field]
            continue
        resolved_str, real_id = _resolve_one_ref(raw[field], map_attr, ctx)
        op_kwargs[field] = resolved_str
        if real_id is not None:
            affected.append(ObjectRef(kind=ref_kind, id=real_id))
    # literal (non-ref) fields pass straight through
    for field in ("new_label", "description", "name", "node_type", "edge_label", "sub_steps"):
        if raw.get(field) is not None:
            op_kwargs[field] = raw[field]

    try:
        op = SuggestionOp(**op_kwargs)
    except (ValueError, TypeError, KeyError):
        return None  # malformed op -> dropped, never reaches the client

    return ChatSuggestion(
        id=f"sg-{index}-{_uuid.uuid4().hex[:8]}",
        group=raw.get("group"),
        title=str(raw.get("title") or op.kind.value)[:300],
        op=op,
        affected_refs=affected,
        rationale=str(raw.get("rationale") or "")[:2000],
        cited_claim_ids=_resolve_refs(raw.get("cited_claim_refs"), ctx.claim_ref_to_id),
    )
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_chat_suggest.py -k build_suggestion -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_chat_suggest.py
git commit -m "feat(chat-suggest): resolve short refs + drop malformed ops into ChatSuggestion"
```

---

## Task 5: The `chat-suggest` endpoint

Wire it together: validate model/version, assemble context, call the service, build suggestions, return `ChatSuggestResponse`. Mirrors `chat_with_map`'s 404/502 handling.

**Files:**
- Modify: `backend/app/api/v2/process_maps.py`
- Test: `backend/tests/test_chat_suggest.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_chat_suggest.py`:

```python
import pytest as _pytest
from fastapi import HTTPException
from uuid import uuid4


def _seed(db):
    from app.enums import ClaimLinkKind
    from app.models.identity import Organization, User
    from app.models.project import Project
    from app.models.claim import Claim
    from app.models.process import (
        NodeClaimLink, ProcessModel, ProcessVersion, ProcessLane, ProcessNode,
    )
    org = Organization(name="O"); db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U"); db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id); db.add(project); db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2"); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1); db.add(version); db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0); db.add(lane); db.flush()
    n1 = ProcessNode(version_id=version.id, lane_id=lane.id, type="task", name="Receive", position={}, properties={})
    db.add(n1); db.flush()
    claim = Claim(project_id=project.id, kind="task", subject="Clerk receives order", normalized={})
    db.add(claim); db.flush()
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    return project, version, n1, claim


def test_chat_suggest_endpoint_resolves_suggestion(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, n1, claim = _seed(db)

    def fake_service(*, history, user_message, map_context_text, mode):
        return ("Here is a fix.", [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
             "title": "Clarify", "rationale": "C1 supports it.",
             "cited_claim_refs": ["C1", "C99"]}])

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest", fake_service)
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="improve N1", mode="suggest"),
            db=db,
        )
    assert resp.message == "Here is a fix."
    assert len(resp.suggestions) == 1
    assert resp.suggestions[0].op.node_ref == str(n1.id)
    assert resp.suggestions[0].cited_claim_ids == [claim.id]   # C99 dropped


def test_chat_suggest_endpoint_ask_mode_has_no_suggestions(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, n1, claim = _seed(db)
    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest",
                   lambda **k: ("Plain answer.", []))
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="what is N1?", mode="ask"),
            db=db,
        )
    assert resp.suggestions == []
    assert resp.message == "Plain answer."


def test_chat_suggest_endpoint_404_for_foreign_model(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, n1, claim = _seed(db)
    with _pytest.raises(HTTPException) as exc:
        pm_api.chat_suggest(
            project=project, model_id=uuid4(), version_id=version.id,
            payload=ChatSuggestRequest(user_message="hi", mode="ask"), db=db,
        )
    assert exc.value.status_code == 404
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_chat_suggest.py -k endpoint -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'chat_suggest'`.

- [ ] **Step 3: Implement**

Add the endpoint to `backend/app/api/v2/process_maps.py`, directly after `ai_edit_node` (after line 1248):

```python
@router.post(
    "/process-maps/{model_id}/versions/{version_id}/chat-suggest",
    response_model=ChatSuggestResponse,
)
def chat_suggest(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    payload: ChatSuggestRequest,
    db: Annotated[Session, Depends(get_db)],
) -> ChatSuggestResponse:
    """Word-style chat. Ask mode answers in prose; suggest mode also returns
    structured, applyable suggested changes. Never mutates the map. Model claim
    refs are resolved to UUIDs and fabricated ones dropped; malformed ops are
    discarded before reaching the client."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    # If a single node is attached as context, label it as the selection.
    selected_node_id = next(
        (r.id for r in payload.context_refs if r.kind == RefKind.NODE), None
    )
    ctx = assemble_map_context(db, version, selected_node_id=selected_node_id)

    history = [SuggestChatTurn(role=t.role, content=t.content) for t in payload.history]
    try:
        message, raw_suggestions = run_chat_suggest(
            history=history,
            user_message=payload.user_message,
            map_context_text=ctx.text,
            mode=payload.mode,
        )
    except RuntimeError as exc:  # missing API key, etc.
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    suggestions = []
    for i, raw in enumerate(raw_suggestions):
        built = _build_suggestion(raw, ctx, index=i)
        if built is not None:
            suggestions.append(built)
    return ChatSuggestResponse(message=message, suggestions=suggestions)
```

Note: `SuggestChatTurn.role` and `content` carry the same field names as `MapChatTurn`, and `run_chat_suggest` in ask mode forwards to `chat()`, which reads `.role`/`.content` — compatible.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_chat_suggest.py -v`
Expected: PASS (all chat-suggest tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_chat_suggest.py
git commit -m "feat(chat-suggest): chat-suggest endpoint (ask + suggest modes)"
```

---

## Task 6: Deterministic consistency scan

A pure function over the map graph that finds structural problems, plus a read-only endpoint. No LLM — fully deterministic and testable. The chat can describe these later (Phase 4); here we ship the detector and the endpoint.

**Files:**
- Create: `backend/app/services/map_consistency.py`
- Create: `backend/tests/test_map_consistency.py`
- Modify: `backend/app/api/v2/process_maps.py` (endpoint)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_map_consistency.py`:

```python
"""Tests for the deterministic whole-map consistency scan."""
from app.services.map_consistency import scan_map, Finding


def _node(nid, name, ntype="task", lane="L1"):
    return {"id": nid, "name": name, "type": ntype, "lane_id": lane}


def _edge(src, tgt):
    return {"source_node_id": src, "target_node_id": tgt}


def test_dangling_edge_detected():
    nodes = [_node("a", "A")]
    edges = [_edge("a", "ghost")]  # target not in nodes
    findings = scan_map(nodes=nodes, edges=edges, lanes=[{"id": "L1", "name": "Ops"}])
    assert any(f.code == "dangling_edge" for f in findings)


def test_duplicate_step_name_detected():
    nodes = [_node("a", "Review"), _node("b", "Review")]
    findings = scan_map(nodes=nodes, edges=[], lanes=[{"id": "L1", "name": "Ops"}])
    dups = [f for f in findings if f.code == "duplicate_name"]
    assert dups and set(dups[0].node_ids) == {"a", "b"}


def test_single_branch_exclusive_gateway_detected():
    nodes = [_node("g", "Approved?", ntype="gateway_exclusive"), _node("a", "A")]
    edges = [_edge("g", "a")]  # only one outgoing branch
    findings = scan_map(nodes=nodes, edges=edges, lanes=[{"id": "L1", "name": "Ops"}])
    assert any(f.code == "single_branch_gateway" and "g" in f.node_ids for f in findings)


def test_orphan_node_detected():
    nodes = [_node("a", "A"), _node("b", "B"), _node("c", "Island")]
    edges = [_edge("a", "b")]  # c has no edges
    findings = scan_map(nodes=nodes, edges=edges, lanes=[{"id": "L1", "name": "Ops"}])
    assert any(f.code == "orphan_node" and f.node_ids == ["c"] for f in findings)


def test_ownerless_lane_detected():
    lanes = [{"id": "L1", "name": "Ops"}, {"id": "L2", "name": ""}]
    findings = scan_map(nodes=[_node("a", "A")], edges=[], lanes=lanes)
    assert any(f.code == "ownerless_lane" and "L2" in f.lane_ids for f in findings)


def test_clean_map_has_no_findings():
    nodes = [_node("a", "A"), _node("b", "B")]
    edges = [_edge("a", "b")]
    findings = scan_map(nodes=nodes, edges=edges, lanes=[{"id": "L1", "name": "Ops"}])
    assert findings == []
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_map_consistency.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.map_consistency'`.

- [ ] **Step 3: Implement**

Create `backend/app/services/map_consistency.py`:

```python
"""Deterministic structural consistency scan for a process map.

Pure function over plain dicts (no DB, no LLM) so it is trivially testable and
reusable. Each Finding names the offending object ids and a severity. The chat
layer can later phrase fixes; this module only detects.
"""
from dataclasses import dataclass, field

_EXCLUSIVE_GATEWAY_TYPES = {"gateway_exclusive", "gateway_inclusive"}


@dataclass
class Finding:
    code: str
    severity: str  # "low" | "medium" | "high"
    summary: str
    node_ids: list[str] = field(default_factory=list)
    edge_keys: list[str] = field(default_factory=list)
    lane_ids: list[str] = field(default_factory=list)


def scan_map(*, nodes: list[dict], edges: list[dict], lanes: list[dict]) -> list[Finding]:
    findings: list[Finding] = []
    node_ids = {n["id"] for n in nodes}

    # 1. Dangling edges: endpoint missing from the node set.
    for e in edges:
        src, tgt = e.get("source_node_id"), e.get("target_node_id")
        if src not in node_ids or tgt not in node_ids:
            findings.append(Finding(
                code="dangling_edge", severity="high",
                summary=f"Edge {src}->{tgt} references a node that does not exist.",
                node_ids=[x for x in (src, tgt) if x in node_ids],
                edge_keys=[f"{src}->{tgt}"],
            ))

    # 2. Duplicate step names (case-insensitive, non-empty).
    by_name: dict[str, list[str]] = {}
    for n in nodes:
        key = (n.get("name") or "").strip().lower()
        if key:
            by_name.setdefault(key, []).append(n["id"])
    for name, ids in by_name.items():
        if len(ids) > 1:
            findings.append(Finding(
                code="duplicate_name", severity="medium",
                summary=f"{len(ids)} steps share the name '{name}'.",
                node_ids=sorted(ids),
            ))

    # 3. Exclusive/inclusive gateways with fewer than two outgoing branches.
    out_count: dict[str, int] = {}
    for e in edges:
        out_count[e.get("source_node_id")] = out_count.get(e.get("source_node_id"), 0) + 1
    for n in nodes:
        if n.get("type") in _EXCLUSIVE_GATEWAY_TYPES and out_count.get(n["id"], 0) < 2:
            findings.append(Finding(
                code="single_branch_gateway", severity="medium",
                summary=f"Decision gateway '{n.get('name')}' has fewer than two outgoing branches.",
                node_ids=[n["id"]],
            ))

    # 4. Orphan nodes: no incoming or outgoing edge (ignore start/end events).
    touched: set[str] = set()
    for e in edges:
        touched.add(e.get("source_node_id"))
        touched.add(e.get("target_node_id"))
    for n in nodes:
        if n["id"] not in touched and n.get("type") not in ("event_start", "event_end"):
            findings.append(Finding(
                code="orphan_node", severity="low",
                summary=f"Step '{n.get('name')}' is not connected to any other step.",
                node_ids=[n["id"]],
            ))

    # 5. Ownerless lanes: blank lane name.
    for l in lanes:
        if not (l.get("name") or "").strip():
            findings.append(Finding(
                code="ownerless_lane", severity="low",
                summary="A lane has no owner/role name.",
                lane_ids=[l["id"]],
            ))

    return findings
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_map_consistency.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the read-only endpoint + its test**

Append to `backend/tests/test_chat_suggest.py`:

```python
def test_consistency_endpoint_reports_findings(db):
    from app.api.v2 import process_maps as pm_api
    from app.models.process import ProcessNode
    project, version, n1, claim = _seed(db)
    # Add a duplicate-named node to trigger a finding.
    dup = ProcessNode(version_id=version.id, lane_id=n1.lane_id, type="task",
                      name=n1.name, position={}, properties={})
    db.add(dup); db.commit()
    resp = pm_api.map_consistency(
        project=project, model_id=version.model_id, version_id=version.id, db=db,
    )
    assert any(f.code == "duplicate_name" for f in resp)
```

Add the endpoint to `process_maps.py` after `chat_suggest`. The `Finding` dataclass serializes via a thin response model:

```python
from app.services.map_consistency import Finding, scan_map


class ConsistencyFinding(BaseModel):
    code: str
    severity: str
    summary: str
    node_ids: list[UUID] = Field(default_factory=list)
    lane_ids: list[UUID] = Field(default_factory=list)


@router.get(
    "/process-maps/{model_id}/versions/{version_id}/consistency",
    response_model=list[ConsistencyFinding],
)
def map_consistency(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> list[ConsistencyFinding]:
    """Deterministic structural problems in the current map version."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    nodes = list(db.scalars(select(ProcessNode).where(ProcessNode.version_id == version.id)).all())
    edges = list(db.scalars(select(ProcessEdge).where(ProcessEdge.version_id == version.id)).all())
    lanes = list(db.scalars(select(ProcessLane).where(ProcessLane.version_id == version.id)).all())

    findings = scan_map(
        nodes=[{"id": str(n.id), "name": n.name, "type": n.type,
                "lane_id": str(n.lane_id) if n.lane_id else None} for n in nodes],
        edges=[{"source_node_id": str(e.source_node_id),
                "target_node_id": str(e.target_node_id)} for e in edges],
        lanes=[{"id": str(l.id), "name": l.name} for l in lanes],
    )
    return [
        ConsistencyFinding(
            code=f.code, severity=f.severity, summary=f.summary,
            node_ids=[UUID(x) for x in f.node_ids],
            lane_ids=[UUID(x) for x in f.lane_ids],
        )
        for f in findings
    ]
```

- [ ] **Step 6: Run the full suite**

Run: `cd /home/ewise/projects/processreengineering/backend && pytest tests/test_chat_suggest.py tests/test_map_consistency.py tests/test_map_context.py tests/test_ai_edit.py -v`
Expected: PASS (all). Then run the whole backend suite to confirm no regressions:
Run: `cd /home/ewise/projects/processreengineering/backend && pytest -ra`
Expected: PASS / no new failures.

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/map_consistency.py backend/tests/test_map_consistency.py \
        backend/app/api/v2/process_maps.py backend/tests/test_chat_suggest.py
git commit -m "feat(chat-suggest): deterministic map consistency scan + endpoint"
```

---

## Phase 1 done — what ships

- `POST .../chat-suggest` returning prose + structured suggestions in suggest mode, prose-only in ask mode, with full claim-ref hygiene and malformed-op dropping.
- The full 12-kind `SuggestionOp` vocabulary validated per kind (decompose included in schema; its *apply* path waits on PR #27).
- Short-ref → UUID resolution with `affected_refs` for navigation and `tmp:N` passthrough for new objects.
- `GET .../consistency` deterministic structural scan.

All verified by `test_chat_suggest.py`, `test_map_consistency.py`, and the extended `test_map_context.py`. No frontend yet — that's Phase 2.

## Self-review notes (already reconciled)

- **Spec coverage:** agentic endpoint ✓ (T5); ask/suggest modes ✓ (T3); suggestion diff-op model incl. temp ids ✓ (T2); ref resolution + fabricated-ref dropping ✓ (T4); consistency scan ✓ (T6). Apply/undo/staleness, mentions, cards, dimming are explicitly Phase 2–4, not gaps.
- **Type consistency:** `_build_suggestion(raw, ctx, index)`, `run_chat_suggest(...)->(str, list[dict])`, `MapContext.{node,edge,lane}_ref_to_id`, and `ChatSuggestion.op.<field>` names are used identically across tasks.
- **Decompose dependency** on PR #27 is flagged and limited to the apply path (later phase), so Phase 1 stays unblocked.
