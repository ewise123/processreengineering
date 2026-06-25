# SP-7c — Map Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship "Refresh from claims" — a reconcile-as-diff that, when a mapped process's claim set drifts from what its map cites, produces targeted accept/reject ops (add a step, re-cite a node, flag a node's evidence stale, relabel a node) that preserve layout and hand edits. The diff is computed in plain code first; one Claude call turns it into grounded ops; ops persist as `map_reconcile` `process_suggestions` so a reconcile survives reload; the existing suggestion-inbox renders them with per-item accept/reject; accepting mutates the map non-destructively.

**Architecture:** A pure delta function (`compute_claim_delta`) reads `process_claim_links` and `NodeClaimLink` to find new-evidence and vanished-evidence — fully unit-tested with no LLM. A new forced-tool service (`map_reconcile.py`, mirroring `map_ai_edit.py`) takes `assemble_map_context(...).text` + the rendered delta and returns an `ops` array citing short refs (`N1`, `C1`); the endpoint resolves refs to UUIDs and drops fabrications (reusing `_resolve_refs` plus a node-ref resolver derived from `MapContext.node_ref_by_id`). A new POST `/.../versions/{version_id}/reconcile` endpoint guards 404/409, early-returns an empty batch when the delta is empty (no LLM call), 503s on LLM failure with nothing persisted, and otherwise writes one `process_suggestions` batch. The `apply_suggestion` dispatcher in `processes.py` gains four reconcile ops: `add_step` reuses an extracted `_create_proposed_step(...)` helper (pulled out of the existing `apply_proposed_step` endpoint body), `recite_node` writes/deletes `NodeClaimLink` rows (Phase 1.3 machinery), `flag_stale_node` sets `node.properties["evidence_stale"]=True`, `relabel_node` updates `node.name`. Stale targets (node/claim deleted in the meantime) no-op and the suggestion resolves `status='rejected'` with `payload["outcome"]="target_gone"`. The canvas reads `properties.evidence_stale` into a small badge; the right panel hosts a new "Refresh" tab reusing `suggestion-inbox.tsx`.

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic (backend, `anthropic==0.40.0`), Next.js 16 + React 19 + TypeScript (frontend), pytest (real `poet_test` Postgres) + Vitest.

**Design doc:** `docs/superpowers/specs/2026-06-09-sp7-process-inventory-design.md` (Phase 3 — Reconcile-as-diff).

**Assumes landed:** sp7a (Phase 1 quick wins) and sp7b (Phase 2 inventory). Specifically: tables `processes`, `process_claim_links`, `process_suggestions` exist; `process_models.process_id` exists; node↔claim endpoints `POST /projects/{id}/nodes/{node_id}/claims` and `DELETE /projects/{id}/nodes/{node_id}/claims/{claim_id}` exist; `backend/app/api/v2/processes.py` exists with an `apply_suggestion(db, suggestion)` dispatcher that handles `create_process`/`assign_claims` and raises 422 on unknown ops; `GET /process-suggestions` / `POST /process-suggestions/{id}/accept` / `POST /process-suggestions/{id}/reject` exist; `src/components/inventory/suggestion-inbox.tsx` exists and is reusable. Migrations 0008/0009 are taken; **this plan needs no new migration** (`flag_stale_node` uses the existing `process_nodes.properties` JSONB, the same column `ai_proposed`/`description` already round-trip through).

---

## File structure

**Backend — create:**
- `backend/app/services/map_reconcile.py` — `compute_claim_delta(db, version, process_id)` (pure) + `propose_reconcile(client, model, context_block, delta)` (one forced tool).
- `backend/app/schemas/version_reconcile.py` — request/response schemas for the reconcile endpoint + the persisted op payload shapes.
- `backend/tests/test_map_reconcile.py` — delta unit tests + service (faked client) tests + endpoint tests.
- `backend/tests/test_reconcile_apply.py` — `apply_suggestion` dispatch tests for the four reconcile ops incl. stale-target.

**Backend — modify:**
- `backend/app/api/v2/process_maps.py` — extract `_create_proposed_step(...)` helper from `apply_proposed_step`'s body; add a node-ref resolver helper; add the `reconcile` endpoint.
- `backend/app/api/v2/processes.py` — extend `apply_suggestion` with the four reconcile ops.

**Frontend — create:**
- `src/components/canvas/reconcile.ts` (+ `.test.ts`) — pure mapping of persisted reconcile-suggestion payloads → suggestion-inbox display rows.

**Frontend — modify:**
- `src/lib/types.ts` — reconcile op/payload/batch types; `evidenceStale` follow-ons.
- `src/lib/api.ts` — `reconcileMap(...)`.
- `src/components/canvas/types.ts` — `evidenceStale?: boolean` on `CanvasNode`.
- `src/components/canvas/layout.ts` — map `properties.evidence_stale` onto the node.
- `src/components/canvas/shapes.tsx` — `evidenceStale` badge on `NodeShape`.
- `src/components/canvas/right-panel.tsx` — new "Refresh" tab calling `reconcileMap` and rendering the batch via `<SuggestionInbox>`.

---

## Conventions (read once)

- **Commit locally only. Never push.** End every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Never use `rm`/`git rm`.**
- **Backend tests** use the dockerized Postgres on `localhost:5433`, DB `poet_test`. Run from `backend/` with the venv: `cd backend && .venv/bin/pytest <args>`. The `db` fixture TRUNCATEs all tables before each test and commits are real.
- After adding any migration (this plan adds none), `alembic upgrade head` the dev `poet` DB or the hot-reloading backend 500s. N/A here.
- **Frontend tests:** `npm test -- <file>` (Vitest, `environment: "node"`, `include: ["src/**/*.test.ts"]` — pure-logic `.test.ts` only; no DOM/component tests in this repo). Type-check: `npx tsc --noEmit`.
- Lint is advisory (7 pre-existing errors baseline); binding gates are tsc + Vitest + pytest.
- The Anthropic forced-tool pattern to mirror lives in `backend/app/services/map_ai_edit.py`: module-level `os.getenv("MAP_*_MODEL", "claude-sonnet-4-6")`, lazy `_get_client()` raising `RuntimeError` when `ANTHROPIC_API_KEY` is unset, `client.messages.create(... tools=[tool], tool_choice={"type":"tool","name":tool["name"]}, timeout=60.0)`, then iterate `response.content` for `block.type == "tool_use"` and read `dict(block.input)`.
- `_resolve_refs(refs, claim_ref_to_id)` already exists at `backend/app/api/v2/process_maps.py:1161` — reuse it for claim refs; this plan adds an analogous node-ref resolver.

---

## Task 1: Pure delta — `compute_claim_delta`

The diff is computed in plain code first: it is cheap, fully testable, and grounds the model. **New evidence** = claims linked to the process via `process_claim_links` but cited by no node in this version. **Vanished evidence** = per node, the claim ids its `NodeClaimLink` rows point at whose claim no longer exists OR is no longer linked to the process.

**Files:**
- Create: `backend/app/services/map_reconcile.py`
- Create: `backend/tests/test_map_reconcile.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_map_reconcile.py`:

```python
"""Tests for SP-7c map reconcile: pure delta, forced-tool service, endpoint."""
from uuid import uuid4

import pytest

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
from app.models.process_inventory import Process, ProcessClaimLink
from app.models.project import Project
from app.services.map_reconcile import compute_claim_delta


def _seed(db):
    """A mapped process whose claim set has drifted from the map's citations.

    - claim_new: linked to the process, cited by NO node     -> new evidence
    - claim_kept: linked to the process AND cited by node n1  -> neither
    - claim_gone: cited by node n1 but NOT linked to process  -> vanished on n1
    - claim_deleted: cited by node n1 but the claim is deleted -> vanished on n1
    """
    org = Organization(name="O")
    db.add(org)
    db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U")
    db.add(user)
    db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id)
    db.add(project)
    db.flush()
    process = Process(project_id=project.id, name="Order to Cash")
    db.add(process)
    db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2", process_id=process.id)
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
    db.add(n1)
    db.flush()

    claim_new = Claim(project_id=project.id, kind="task", subject="New step appears", normalized={})
    claim_kept = Claim(project_id=project.id, kind="task", subject="Receive the order", normalized={})
    claim_gone = Claim(project_id=project.id, kind="task", subject="No longer in scope", normalized={})
    claim_deleted = Claim(project_id=project.id, kind="task", subject="Will be deleted", normalized={})
    db.add_all([claim_new, claim_kept, claim_gone, claim_deleted])
    db.flush()

    # Process links: new + kept + gone-was-removed... but claim_gone is NOT linked.
    db.add(ProcessClaimLink(process_id=process.id, claim_id=claim_new.id))
    db.add(ProcessClaimLink(process_id=process.id, claim_id=claim_kept.id))
    db.flush()

    # Node citations: kept (still linked), gone (not linked), deleted (claim removed).
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim_kept.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim_gone.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    deleted_link = NodeClaimLink(
        node_id=n1.id, claim_id=claim_deleted.id, link_kind=ClaimLinkKind.SUPPORTS.value
    )
    db.add(deleted_link)
    db.flush()
    # Delete claim_deleted's row but the node link cascades on the FK, so to
    # simulate a *dangling* citation we instead delete via the citation having a
    # claim that no longer exists: emulate by removing the claim row directly.
    db.delete(claim_deleted)
    db.commit()
    return process, version, n1, claim_new, claim_kept, claim_gone


def test_compute_claim_delta_new_and_vanished(db):
    process, version, n1, claim_new, claim_kept, claim_gone = _seed(db)
    delta = compute_claim_delta(db, version, process.id)

    # New evidence = claim linked to process but cited by no node.
    assert [c.id for c in delta.new_evidence] == [claim_new.id]

    # Vanished evidence keyed by node id; claim_gone is no longer linked to the
    # process. (claim_deleted's NodeClaimLink was cascade-removed when the claim
    # was deleted, so it cannot appear — only live citations can vanish.)
    assert n1.id in delta.vanished_evidence
    assert claim_gone.id in delta.vanished_evidence[n1.id]
    assert claim_kept.id not in delta.vanished_evidence.get(n1.id, [])


def test_compute_claim_delta_empty_when_in_sync(db):
    process, version, n1, claim_new, claim_kept, claim_gone = _seed(db)
    # Bring it into sync: link claim_gone to the process, and cite claim_new on n1.
    db.add(ProcessClaimLink(process_id=process.id, claim_id=claim_gone.id))
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim_new.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    delta = compute_claim_delta(db, version, process.id)
    assert delta.new_evidence == []
    assert all(len(v) == 0 for v in delta.vanished_evidence.values())
    assert delta.is_empty()
```

> Adjust the `Process`/`ProcessClaimLink` import path (`app.models.process_inventory`) if sp7b placed them in a different module — grep `class Process(` / `class ProcessClaimLink(` under `backend/app/models/` first and use the real path. Likewise confirm `User`/`Project` use `org_id` (the sp5a outcome noted the real field is `org_id`, not `organization_id`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_map_reconcile.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.map_reconcile'`.

- [ ] **Step 3: Write the delta function**

Create `backend/app/services/map_reconcile.py`:

```python
"""Map reconcile (SP-7c).

Two pieces, kept separate so the diff is testable without an LLM:

1. ``compute_claim_delta`` — pure code. Reads the durable process->claim links
   and the version's node->claim citations to find what drifted:
   * new evidence: claims linked to the process but cited by no node here;
   * vanished evidence: per node, the claims it still cites that are no longer
     linked to the process (deleted claims cascade their citations away, so a
     *dangling* citation cannot occur — only live-but-unlinked claims vanish).

2. ``propose_reconcile`` — one forced Anthropic call (mirrors map_ai_edit.py)
   that turns the rendered map context + delta into an ``ops`` array citing
   short refs (N1, C1). Ref resolution + fabrication-dropping happens in the
   endpoint, not here.
"""
import os
from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.claim import Claim
from app.models.process import NodeClaimLink, ProcessNode
from app.models.process_inventory import ProcessClaimLink  # adjust path per sp7b


@dataclass
class ClaimDelta:
    """New + vanished evidence for one (version, process) pair."""

    new_evidence: list[Claim] = field(default_factory=list)
    # node_id -> claim ids the node still cites that are no longer in the process
    vanished_evidence: dict[UUID, list[UUID]] = field(default_factory=dict)

    def is_empty(self) -> bool:
        return not self.new_evidence and not any(self.vanished_evidence.values())


def compute_claim_delta(db: Session, version, process_id: UUID) -> ClaimDelta:
    """Diff the durable process claim set against this version's citations."""
    # Claims currently linked to the process (durable scope).
    process_claim_ids = set(
        db.scalars(
            select(ProcessClaimLink.claim_id).where(
                ProcessClaimLink.process_id == process_id
            )
        ).all()
    )

    # Claim ids cited by any node in this version, with their node ids.
    citation_rows = list(
        db.execute(
            select(NodeClaimLink.node_id, NodeClaimLink.claim_id)
            .join(ProcessNode, NodeClaimLink.node_id == ProcessNode.id)
            .where(ProcessNode.version_id == version.id)
        ).all()
    )
    cited_claim_ids = {claim_id for _, claim_id in citation_rows}

    # New evidence: linked to process, cited by no node here. Load the Claim
    # rows (the prompt renders their kind/subject).
    new_ids = process_claim_ids - cited_claim_ids
    new_evidence = (
        list(db.scalars(select(Claim).where(Claim.id.in_(new_ids))).all())
        if new_ids
        else []
    )
    # Stable order by subject for deterministic prompts/tests.
    new_evidence.sort(key=lambda c: (c.subject or "", str(c.id)))

    # Vanished evidence: a cited claim no longer linked to the process.
    vanished: dict[UUID, list[UUID]] = {}
    for node_id, claim_id in citation_rows:
        if claim_id not in process_claim_ids:
            vanished.setdefault(node_id, [])
            if claim_id not in vanished[node_id]:
                vanished[node_id].append(claim_id)

    return ClaimDelta(new_evidence=new_evidence, vanished_evidence=vanished)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_map_reconcile.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_reconcile.py backend/tests/test_map_reconcile.py
git commit -m "$(printf 'feat(sp7c): pure compute_claim_delta (new + vanished evidence)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 2: Reconcile request/response + persisted-op schemas

The endpoint returns a batch of pending suggestions. Each suggestion is one reconcile op with a UUID-resolved payload. Schemas pin the op vocabulary and payload shapes so the dispatcher (Task 8) and frontend (Task 9) share one contract.

**Files:**
- Create: `backend/app/schemas/version_reconcile.py`
- Test: `backend/tests/test_map_reconcile.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_map_reconcile.py`:

```python
from app.schemas.version_reconcile import ReconcileOp, ReconcileSuggestionRead


def test_reconcile_op_vocabulary():
    for op in ["add_step", "recite_node", "flag_stale_node", "relabel_node"]:
        assert ReconcileOp(op).value == op


def test_reconcile_op_rejects_unknown():
    with pytest.raises(ValueError):
        ReconcileOp("delete_map")


def test_reconcile_suggestion_read_shape():
    sug = ReconcileSuggestionRead(
        id=uuid4(),
        batch_id=uuid4(),
        op=ReconcileOp.RELABEL_NODE,
        payload={"node_id": str(uuid4()), "proposed_name": "Receive PO"},
        rationale="C1 says PO, not order.",
        confidence=0.8,
        status="pending",
    )
    assert sug.op == ReconcileOp.RELABEL_NODE
    assert sug.payload["proposed_name"] == "Receive PO"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_map_reconcile.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.schemas.version_reconcile'`.

- [ ] **Step 3: Write the schemas**

Create `backend/app/schemas/version_reconcile.py`:

```python
"""Schemas for SP-7c map reconcile.

The reconcile endpoint persists one ``process_suggestions`` row per op (shared
``batch_id``, ``kind='map_reconcile'``, ``version_id`` set) and returns the
pending batch. Op payloads carry **resolved UUIDs** (the endpoint has already
mapped the model's short refs to real ids and dropped fabrications).
"""
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field


class ReconcileOp(StrEnum):
    ADD_STEP = "add_step"
    RECITE_NODE = "recite_node"
    FLAG_STALE_NODE = "flag_stale_node"
    RELABEL_NODE = "relabel_node"


class ReconcileRequest(BaseModel):
    """No body fields today; reserved so the route can accept an empty POST."""


class ReconcileSuggestionRead(BaseModel):
    id: UUID
    batch_id: UUID
    op: ReconcileOp
    payload: dict
    rationale: str = ""
    confidence: float | None = None
    status: str = "pending"


class ReconcileBatchRead(BaseModel):
    """The reconcile result. ``empty`` is True when the delta was empty and no
    LLM call was made (the batch has no suggestions)."""

    batch_id: UUID | None
    version_id: UUID
    empty: bool
    suggestions: list[ReconcileSuggestionRead] = Field(default_factory=list)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_map_reconcile.py -v`
Expected: PASS (delta tests + 3 schema tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/version_reconcile.py backend/tests/test_map_reconcile.py
git commit -m "$(printf 'feat(sp7c): reconcile op vocabulary + batch schemas\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 3: The LLM call — `propose_reconcile` (forced tool)

One synchronous Anthropic call with a single forced tool returning an `ops` array. Mirrors `map_ai_edit._run`: module-level model env var, lazy `_get_client()`, `tool_choice` forced, iterate `response.content`. The model cites nodes by `N#` refs and claims by `C#` refs from the grounding context; resolution happens in the endpoint (Task 4).

**Files:**
- Modify: `backend/app/services/map_reconcile.py` (add tool schema + `propose_reconcile`)
- Test: `backend/tests/test_map_reconcile.py` (extend, faked client)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_map_reconcile.py`:

```python
from types import SimpleNamespace
from unittest.mock import patch

from app.services import map_reconcile


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


def test_propose_reconcile_parses_ops():
    fake = _FakeClient(
        "propose_reconcile",
        {
            "ops": [
                {
                    "op": "add_step",
                    "name": "Verify budget",
                    "type": "task",
                    "after_node_ref": "N1",
                    "lane_ref": "L1",
                    "lane_name": None,
                    "edge_label": "if over $10k",
                    "cited_claim_refs": ["C1"],
                    "rationale": "C1 implies a budget check.",
                },
                {
                    "op": "flag_stale_node",
                    "node_ref": "N1",
                    "vanished_claim_refs": ["C2"],
                    "rationale": "C2 no longer scoped.",
                },
            ]
        },
    )
    out = map_reconcile.propose_reconcile(
        client=fake, model="m", context_block="...", delta_block="..."
    )
    assert out["ops"][0]["op"] == "add_step"
    assert out["ops"][1]["node_ref"] == "N1"


def test_propose_reconcile_empty_on_malformed():
    fake = _FakeClient("not_the_tool", {"junk": True})
    out = map_reconcile.propose_reconcile(
        client=fake, model="m", context_block="...", delta_block="..."
    )
    assert out == {"ops": []}


def test_get_client_raises_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    map_reconcile._client = None
    with pytest.raises(RuntimeError):
        map_reconcile._get_client()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_map_reconcile.py -v`
Expected: FAIL — `AttributeError: module 'app.services.map_reconcile' has no attribute 'propose_reconcile'`.

- [ ] **Step 3: Add the tool + service to `map_reconcile.py`**

In `backend/app/services/map_reconcile.py`, add `import anthropic` to the imports and append:

```python
import anthropic  # add to the import block at top

from app.enums import NodeType
from app.services.map_chat import SYSTEM_PROMPT as CHAT_GUARDRAILS

RECONCILE_MODEL = os.getenv("MAP_RECONCILE_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 2000  # an ops array over several nodes can be long; degrade to fewer ops if truncated

_NODE_TYPES = [t.value for t in NodeType]

_NODE_REF = {
    "type": "string",
    "description": "A node short ref (e.g. N1, N2) taken verbatim from the grounding context. Use ONLY refs that appear there.",
}
_CLAIM_REFS = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Claim short refs (e.g. C1, C2) taken verbatim from the grounding context. Use ONLY refs that appear there; never invent one.",
}

RECONCILE_TOOL = {
    "name": "propose_reconcile",
    "description": (
        "Reconcile a process map against its claim set. Given the new evidence "
        "(claims now in the process but cited by no step) and vanished evidence "
        "(claims a step still cites but that left the process), propose the "
        "smallest set of ops that brings the map back in line WITHOUT discarding "
        "layout or hand edits. Prefer recite/flag/relabel over adding steps; only "
        "add a step when new evidence clearly describes an unmapped activity."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "ops": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "op": {
                            "type": "string",
                            "enum": [
                                "add_step",
                                "recite_node",
                                "flag_stale_node",
                                "relabel_node",
                            ],
                        },
                        # add_step
                        "name": {"type": ["string", "null"]},
                        "type": {"type": ["string", "null"], "enum": _NODE_TYPES + [None]},
                        "after_node_ref": {"type": ["string", "null"]},
                        "lane_ref": {"type": ["string", "null"]},
                        "lane_name": {"type": ["string", "null"]},
                        "edge_label": {"type": ["string", "null"]},
                        "cited_claim_refs": _CLAIM_REFS,
                        # recite_node
                        "node_ref": {"type": ["string", "null"]},
                        "add_claim_refs": _CLAIM_REFS,
                        "remove_claim_refs": _CLAIM_REFS,
                        # flag_stale_node
                        "vanished_claim_refs": _CLAIM_REFS,
                        # relabel_node
                        "proposed_name": {"type": ["string", "null"]},
                        # all ops
                        "rationale": {"type": "string"},
                    },
                    "required": ["op", "rationale"],
                },
            }
        },
        "required": ["ops"],
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


def propose_reconcile(*, client, model: str, context_block: str, delta_block: str) -> dict:
    """One forced-tool call. ``client`` is injected so the endpoint can pass
    ``_get_client()`` and tests can pass a fake. Returns ``{"ops": [...]}`` with
    short refs intact; the endpoint resolves them. Malformed/empty tool calls
    degrade to ``{"ops": []}``."""
    system = (
        CHAT_GUARDRAILS
        + "\n\n---\nTask: reconcile the process map against its claim set using the "
        "propose_reconcile tool. Make the smallest faithful set of ops.\n\n"
        "---\nCurrent process map (grounded source of truth):\n"
        + context_block
        + "\n\n---\nDrift to reconcile:\n"
        + delta_block
    )
    user = "Reconcile this map. Use the propose_reconcile tool."
    response = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        system=system,
        tools=[RECONCILE_TOOL],
        tool_choice={"type": "tool", "name": RECONCILE_TOOL["name"]},
        messages=[{"role": "user", "content": user}],
        timeout=60.0,
    )
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == RECONCILE_TOOL["name"]:
            raw = dict(block.input)
            return {"ops": list(raw.get("ops", []))}
    return {"ops": []}
```

> `propose_reconcile` takes `client` as a keyword arg (unlike `map_ai_edit`, which resolves its client internally) so the endpoint can pass `_get_client()` once and tests inject a fake without `patch.object`. The `_get_client()` helper still exists and is what the endpoint calls.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_map_reconcile.py -v`
Expected: PASS (delta + schema + 3 service tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_reconcile.py backend/tests/test_map_reconcile.py
git commit -m "$(printf 'feat(sp7c): propose_reconcile forced-tool service\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 4: Extract `_create_proposed_step` from `apply_proposed_step`

`apply_proposed_step` (`process_maps.py:1256-1336`) inlines the node-creation logic the reconcile `add_step` accept must reuse: create node → flush → stamp `LINEAGE_KEY` + `ai_proposed` → create edge from source → link project-scoped cited claims as `AI_PROPOSED`. The endpoint also does 404/422 project-scope guards the dispatcher doesn't need (the dispatcher already has a project-scoped suggestion). Extract the **creation** logic into a helper both call.

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (extract helper; rewire `apply_proposed_step`)
- Test: existing `backend/tests/test_ai_edit.py` already covers `apply_proposed_step` end-to-end; rerun it as the regression gate.

- [ ] **Step 1: Add the helper**

In `backend/app/api/v2/process_maps.py`, just **above** `apply_proposed_step` (before its `@router.post` decorator at line 1251), add:

```python
def _create_proposed_step(
    db: Session,
    *,
    version_id: UUID,
    source: ProcessNode,
    lane_id: UUID,
    name: str,
    node_type: str,
    x: float,
    relative_y: float,
    edge_label: str | None,
    cited_claim_ids: list[UUID],
    project_id: UUID,
) -> tuple[ProcessNode, ProcessEdge]:
    """Create one ai_proposed node downstream of ``source`` plus the connecting
    edge and AI_PROPOSED NodeClaimLinks for cited claims that genuinely belong to
    ``project_id``. Caller owns the transaction (no commit here). Shared by the
    ai-proposed-step endpoint and the SP-7c reconcile ``add_step`` accept."""
    node = ProcessNode(
        version_id=version_id,
        type=node_type,
        name=name,
        lane_id=lane_id,
        position={"x": x, "relative_y": relative_y},
        properties={},
    )
    db.add(node)
    db.flush()
    node.properties = {**node.properties, LINEAGE_KEY: str(node.id), "ai_proposed": True}
    flag_modified(node, "properties")

    edge = ProcessEdge(
        version_id=version_id,
        source_node_id=source.id,
        target_node_id=node.id,
        label=edge_label or None,
    )
    db.add(edge)

    if cited_claim_ids:
        real_claims = list(
            db.scalars(
                select(Claim).where(
                    Claim.id.in_(cited_claim_ids),
                    Claim.project_id == project_id,
                )
            ).all()
        )
        for claim in real_claims:
            db.add(
                NodeClaimLink(
                    node_id=node.id,
                    claim_id=claim.id,
                    link_kind=ClaimLinkKind.AI_PROPOSED.value,
                )
            )
    return node, edge
```

- [ ] **Step 2: Rewire `apply_proposed_step` to call it**

Replace the body of `apply_proposed_step` from the `# Create the new node` comment (line 1286) through the `for claim in real_claims:` loop (ending line 1328) with a single call, keeping the 404/422 guards and the trailing commit/refresh/return unchanged:

```python
    node, edge = _create_proposed_step(
        db,
        version_id=version.id,
        source=source,
        lane_id=payload.lane_id,
        name=payload.name,
        node_type=payload.type,
        x=payload.x,
        relative_y=payload.relative_y,
        edge_label=payload.edge_label,
        cited_claim_ids=payload.cited_claim_ids,
        project_id=project.id,
    )

    db.commit()
    db.refresh(node)
    db.refresh(edge)
    return AiProposedStepResult(
        node=ProcessNodeRead.model_validate(node),
        edge=ProcessEdgeRead.model_validate(edge),
    )
```

- [ ] **Step 3: Verify no behavior change**

Run: `cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`
Expected: PASS — `test_apply_proposed_step_creates_ai_proposed_node_and_links` and `test_deleting_proposed_node_cascades_edge` still green (the helper is behavior-preserving).

- [ ] **Step 4: Commit**

```bash
git add backend/app/api/v2/process_maps.py
git commit -m "$(printf 'refactor(sp7c): extract _create_proposed_step for reconcile reuse\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 5: Node-ref resolver + the `reconcile` endpoint

The endpoint: 404 guards (model/version), 409 when the map's model has no `process_id`, computes the delta, **early-returns an empty batch (no LLM call) when the delta is empty**, otherwise renders the delta + context, calls `propose_reconcile`, resolves refs (claims via `_resolve_refs`; nodes via a new resolver inverting `MapContext.node_ref_by_id`), drops fabrications, persists one `process_suggestions` batch (`kind='map_reconcile'`, shared `batch_id`, `version_id` set, `process_id` set, `status='pending'`), and returns the batch. **503 on LLM failure with nothing persisted** (suggestions are written only after a parsed response).

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (resolver + endpoint + imports)
- Test: `backend/tests/test_map_reconcile.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_map_reconcile.py`:

```python
from fastapi import HTTPException
from sqlalchemy import select as _select

from app.api.v2 import process_maps as pm_api
from app.models.process_inventory import ProcessSuggestion  # adjust path per sp7b
from app.schemas.version_reconcile import ReconcileRequest


def test_reconcile_empty_delta_no_llm_no_persist(db):
    process, version, n1, claim_new, claim_kept, claim_gone = _seed(db)
    # Bring into sync so the delta is empty.
    db.add(ProcessClaimLink(process_id=process.id, claim_id=claim_gone.id))
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim_new.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    project = db.get(type(version).__mro__[0], version.id)  # placeholder; see note

    # Patch the service so a stray LLM call would blow up the test.
    with patch.object(pm_api, "propose_reconcile", side_effect=AssertionError("LLM called")):
        resp = pm_api.reconcile_map(
            project=_project_of(db, version),
            model_id=version.model_id,
            version_id=version.id,
            payload=ReconcileRequest(),
            db=db,
        )
    assert resp.empty is True
    assert resp.batch_id is None
    assert resp.suggestions == []
    assert db.scalars(_select(ProcessSuggestion)).first() is None


def test_reconcile_persists_batch_and_resolves_refs(db):
    process, version, n1, claim_new, claim_kept, claim_gone = _seed(db)
    # Model returns one valid add_step (cites C-of-claim_new) + a relabel of N1
    # citing a fabricated node ref (N99 -> dropped, op skipped).
    def fake_propose(*, client, model, context_block, delta_block):
        return {
            "ops": [
                {
                    "op": "add_step",
                    "name": "New step",
                    "type": "task",
                    "after_node_ref": "N1",
                    "lane_ref": "L1",
                    "lane_name": None,
                    "edge_label": None,
                    "cited_claim_refs": ["C1"],
                    "rationale": "new evidence",
                },
                {
                    "op": "relabel_node",
                    "node_ref": "N99",
                    "proposed_name": "Bogus",
                    "rationale": "fabricated node",
                },
            ]
        }

    with patch.object(pm_api, "propose_reconcile", fake_propose), \
         patch.object(pm_api, "_reconcile_client", return_value=object()):
        resp = pm_api.reconcile_map(
            project=_project_of(db, version),
            model_id=version.model_id,
            version_id=version.id,
            payload=ReconcileRequest(),
            db=db,
        )
    assert resp.empty is False
    assert resp.batch_id is not None
    ops = [s.op for s in resp.suggestions]
    assert "add_step" in ops
    # The relabel on the fabricated node ref was dropped (no resolvable node).
    assert "relabel_node" not in ops
    rows = list(db.scalars(_select(ProcessSuggestion).where(
        ProcessSuggestion.batch_id == resp.batch_id)).all())
    assert len(rows) == len(resp.suggestions)
    assert all(r.kind == "map_reconcile" and r.version_id == version.id for r in rows)


def test_reconcile_409_when_map_has_no_process(db):
    process, version, n1, *_ = _seed(db)
    model = db.get(ProcessModel, version.model_id)
    model.process_id = None
    db.commit()
    with pytest.raises(HTTPException) as exc:
        pm_api.reconcile_map(
            project=_project_of(db, version),
            model_id=version.model_id,
            version_id=version.id,
            payload=ReconcileRequest(),
            db=db,
        )
    assert exc.value.status_code == 409


def test_reconcile_503_on_llm_failure_persists_nothing(db):
    process, version, n1, *_ = _seed(db)  # non-empty delta from _seed
    with patch.object(pm_api, "_reconcile_client", return_value=object()), \
         patch.object(pm_api, "propose_reconcile", side_effect=RuntimeError("boom")):
        with pytest.raises(HTTPException) as exc:
            pm_api.reconcile_map(
                project=_project_of(db, version),
                model_id=version.model_id,
                version_id=version.id,
                payload=ReconcileRequest(),
                db=db,
            )
    assert exc.value.status_code == 503
    assert db.scalars(_select(ProcessSuggestion)).first() is None


def _project_of(db, version):
    """Return the Project the version belongs to (the route dependency would)."""
    from app.models.project import Project
    model = db.get(ProcessModel, version.model_id)
    return db.get(Project, model.project_id)
```

> The `test_reconcile_empty_delta_no_llm_no_persist` body has a placeholder `project = db.get(...)` line that must be deleted — it only uses `_project_of(db, version)`. Remove the placeholder line when implementing; do not leave it. The endpoint calls a thin `_reconcile_client()` wrapper around `map_reconcile._get_client()` so tests can patch it without a real key.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_map_reconcile.py -v`
Expected: FAIL — `AttributeError: module 'app.api.v2.process_maps' has no attribute 'reconcile_map'`.

- [ ] **Step 3: Add imports, resolver, client wrapper, and endpoint**

In `backend/app/api/v2/process_maps.py`, add to the service-import area (near line 82's `from app.services.map_context import assemble_map_context`):

```python
from app.services.map_reconcile import (
    compute_claim_delta,
    propose_reconcile,
)
from app.services import map_reconcile as _map_reconcile_mod
from app.schemas.version_reconcile import (
    ReconcileBatchRead,
    ReconcileOp,
    ReconcileRequest,
    ReconcileSuggestionRead,
)
```

Add to the model imports (near line 22's `from app.models.process import (...)`) the inventory models — **use the real sp7b paths** (grep first):

```python
from app.models.process_inventory import ProcessClaimLink, ProcessSuggestion  # adjust path
```

Add the node-ref resolver, the client wrapper, and the delta renderer near `_resolve_refs` (after line 1169):

```python
def _resolve_node_ref(ref, node_id_by_ref):
    """Map one node short ref (N1) to its UUID; None if absent/fabricated."""
    if ref is None:
        return None
    return node_id_by_ref.get(str(ref).strip().upper())


def _reconcile_client():
    """Thin wrapper so the endpoint resolves the Anthropic client lazily and
    tests can patch it without a real key."""
    return _map_reconcile_mod._get_client()


def _render_delta(delta, ctx) -> str:
    """Compact, ref-anchored rendering of the delta for the prompt."""
    lines: list[str] = []
    if delta.new_evidence:
        lines.append("New evidence (claims in the process, cited by no step):")
        # Claims appear as C# in ctx.claim_ref_to_id; invert for display.
        ref_by_claim = {cid: ref for ref, cid in ctx.claim_ref_to_id.items()}
        for c in delta.new_evidence:
            ref = ref_by_claim.get(c.id, "?")
            lines.append(f"  {ref}: [{c.kind}] {c.subject}")
    if any(delta.vanished_evidence.values()):
        lines.append("Vanished evidence (claims a step cites but that left the process):")
        ref_by_claim = {cid: ref for ref, cid in ctx.claim_ref_to_id.items()}
        for node_id, claim_ids in delta.vanished_evidence.items():
            node_ref = ctx.node_ref_by_id.get(node_id, "?")
            for cid in claim_ids:
                lines.append(f"  {node_ref} still cites {ref_by_claim.get(cid, '?')}")
    return "\n".join(lines) if lines else "(no drift)"
```

Then add the endpoint (place it after `apply_proposed_step`):

```python
@router.post(
    "/process-maps/{model_id}/versions/{version_id}/reconcile",
    response_model=ReconcileBatchRead,
)
def reconcile_map(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    payload: ReconcileRequest,
    db: Annotated[Session, Depends(get_db)],
) -> ReconcileBatchRead:
    """Refresh a map from its process's claims. Computes the claim delta in
    plain code; if it is empty, returns an empty batch with NO LLM call. Else
    asks Claude for reconcile ops, resolves their refs to real UUIDs (dropping
    fabrications), and persists one map_reconcile suggestion batch. LLM failure
    -> 503 with nothing persisted."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    if model.process_id is None:
        raise HTTPException(
            status_code=409,
            detail="This map is not linked to a process; attach it before reconciling.",
        )

    delta = compute_claim_delta(db, version, model.process_id)
    if delta.is_empty():
        return ReconcileBatchRead(
            batch_id=None, version_id=version.id, empty=True, suggestions=[]
        )

    ctx = assemble_map_context(db, version, selected_node_id=None)
    node_id_by_ref = {ref: nid for nid, ref in ctx.node_ref_by_id.items()}
    delta_block = _render_delta(delta, ctx)

    try:
        client = _reconcile_client()  # raises RuntimeError if no key
        raw = propose_reconcile(
            client=client,
            model=_map_reconcile_mod.RECONCILE_MODEL,
            context_block=ctx.text,
            delta_block=delta_block,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    batch_id = uuid4()
    rows: list[ProcessSuggestion] = []
    for op in raw.get("ops", []):
        kind = op.get("op")
        payload_out: dict | None = None
        if kind == ReconcileOp.ADD_STEP.value:
            after_id = _resolve_node_ref(op.get("after_node_ref"), node_id_by_ref)
            if after_id is None:
                continue  # fabricated anchor -> drop
            payload_out = {
                "name": (op.get("name") or "").strip(),
                "type": op.get("type") or "task",
                "after_node_id": str(after_id),
                "lane_ref": op.get("lane_ref"),
                "lane_name": op.get("lane_name"),
                "edge_label": op.get("edge_label"),
                "cited_claim_ids": [str(c) for c in _resolve_refs(op.get("cited_claim_refs"), ctx.claim_ref_to_id)],
            }
            if not payload_out["name"]:
                continue
        elif kind == ReconcileOp.RECITE_NODE.value:
            node_id = _resolve_node_ref(op.get("node_ref"), node_id_by_ref)
            if node_id is None:
                continue
            payload_out = {
                "node_id": str(node_id),
                "add_claim_ids": [str(c) for c in _resolve_refs(op.get("add_claim_refs"), ctx.claim_ref_to_id)],
                "remove_claim_ids": [str(c) for c in _resolve_refs(op.get("remove_claim_refs"), ctx.claim_ref_to_id)],
            }
        elif kind == ReconcileOp.FLAG_STALE_NODE.value:
            node_id = _resolve_node_ref(op.get("node_ref"), node_id_by_ref)
            if node_id is None:
                continue
            payload_out = {
                "node_id": str(node_id),
                "vanished_claim_ids": [str(c) for c in _resolve_refs(op.get("vanished_claim_refs"), ctx.claim_ref_to_id)],
            }
        elif kind == ReconcileOp.RELABEL_NODE.value:
            node_id = _resolve_node_ref(op.get("node_ref"), node_id_by_ref)
            proposed = (op.get("proposed_name") or "").strip()
            if node_id is None or not proposed:
                continue
            payload_out = {"node_id": str(node_id), "proposed_name": proposed}
        else:
            continue  # unknown op -> drop

        rows.append(
            ProcessSuggestion(
                batch_id=batch_id,
                project_id=project.id,
                kind="map_reconcile",
                process_id=model.process_id,
                version_id=version.id,
                op=kind,
                payload=payload_out,
                rationale=op.get("rationale", ""),
                status="pending",
            )
        )

    for r in rows:
        db.add(r)
    db.commit()
    for r in rows:
        db.refresh(r)

    return ReconcileBatchRead(
        batch_id=batch_id,
        version_id=version.id,
        empty=False,
        suggestions=[
            ReconcileSuggestionRead(
                id=r.id,
                batch_id=r.batch_id,
                op=ReconcileOp(r.op),
                payload=r.payload,
                rationale=r.rationale or "",
                confidence=r.confidence,
                status=r.status,
            )
            for r in rows
        ],
    )
```

> `uuid4` and `select`/`Claim` are already imported in this module (used by `apply_proposed_step`). Confirm `ProcessSuggestion`'s constructor field names against the sp7b model (`batch_id`, `project_id`, `kind`, `process_id`, `version_id`, `op`, `payload`, `rationale`, `status`, `confidence`) — they come straight from the spec's table; adjust if sp7b renamed any. If `ProcessSuggestion.confidence` is nullable and unset here, leave it out of the constructor.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_map_reconcile.py -v`
Expected: PASS (empty-delta no-LLM, persist+resolve, 409, 503).

- [ ] **Step 5: Confirm the module still imports + full suite**

Run: `cd backend && .venv/bin/python -c "import app.api.v2.process_maps"`
Expected: no error.
Run: `cd backend && .venv/bin/pytest -q`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_map_reconcile.py
git commit -m "$(printf 'feat(sp7c): reconcile endpoint (empty-delta short-circuit, 409, 503, ref hygiene)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 6: Extend `apply_suggestion` — `add_step` + `recite_node`

Extend the dispatcher in `processes.py` for the first two reconcile ops. `add_step` reuses `_create_proposed_step` (Task 4). `recite_node` inserts missing `NodeClaimLink` rows (idempotent on `uq_node_claim_links_node_claim`) and deletes the requested ones. Stale targets (node/claim gone) no-op and mark the suggestion `status='rejected'` with `payload["outcome"]="target_gone"`.

**Files:**
- Modify: `backend/app/api/v2/processes.py` (extend `apply_suggestion`)
- Create: `backend/tests/test_reconcile_apply.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_reconcile_apply.py`:

```python
"""apply_suggestion dispatch for SP-7c reconcile ops."""
from uuid import uuid4

from sqlalchemy import select

from app.api.v2 import processes as proc_api
from app.enums import ClaimLinkKind
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process import NodeClaimLink, ProcessEdge, ProcessLane, ProcessModel, ProcessNode, ProcessVersion
from app.models.process_inventory import Process, ProcessClaimLink, ProcessSuggestion  # adjust path
from app.models.project import Project


def _seed_map(db):
    org = Organization(name="O"); db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U"); db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id); db.add(project); db.flush()
    process = Process(project_id=project.id, name="P1"); db.add(process); db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2", process_id=process.id); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1); db.add(version); db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0); db.add(lane); db.flush()
    n1 = ProcessNode(version_id=version.id, lane_id=lane.id, type="task", name="Receive", position={"x": 0, "relative_y": 0}, properties={})
    db.add(n1); db.flush()
    claim = Claim(project_id=project.id, kind="task", subject="A claim", normalized={}); db.add(claim); db.flush()
    db.add(ProcessClaimLink(process_id=process.id, claim_id=claim.id)); db.commit()
    return project, process, version, lane, n1, claim


def _suggestion(db, project, process, version, op, payload):
    s = ProcessSuggestion(
        batch_id=uuid4(), project_id=project.id, kind="map_reconcile",
        process_id=process.id, version_id=version.id, op=op, payload=payload,
        rationale="r", status="pending",
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


def test_apply_add_step(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "add_step", {
        "name": "Verify budget", "type": "task", "after_node_id": str(n1.id),
        "lane_ref": None, "lane_name": None, "edge_label": "if over $10k",
        "cited_claim_ids": [str(claim.id)],
    })
    proc_api.apply_suggestion(db, s)
    db.commit()
    new_nodes = list(db.scalars(select(ProcessNode).where(ProcessNode.version_id == version.id, ProcessNode.name == "Verify budget")).all())
    assert len(new_nodes) == 1
    new_node = new_nodes[0]
    assert new_node.properties["ai_proposed"] is True
    edge = db.scalars(select(ProcessEdge).where(ProcessEdge.target_node_id == new_node.id)).one()
    assert edge.source_node_id == n1.id
    links = list(db.scalars(select(NodeClaimLink).where(NodeClaimLink.node_id == new_node.id)).all())
    assert [l.claim_id for l in links] == [claim.id]
    db.refresh(s)
    assert s.status == "accepted"


def test_apply_add_step_target_gone(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "add_step", {
        "name": "Orphan", "type": "task", "after_node_id": str(uuid4()),
        "lane_ref": None, "lane_name": None, "edge_label": None, "cited_claim_ids": [],
    })
    proc_api.apply_suggestion(db, s); db.commit()
    assert db.scalars(select(ProcessNode).where(ProcessNode.name == "Orphan")).first() is None
    db.refresh(s)
    assert s.status == "rejected"
    assert s.payload["outcome"] == "target_gone"


def test_apply_recite_node_add_and_remove(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    other = Claim(project_id=project.id, kind="task", subject="Other", normalized={}); db.add(other); db.flush()
    # Pre-existing link to be removed.
    db.add(NodeClaimLink(node_id=n1.id, claim_id=other.id, link_kind=ClaimLinkKind.SUPPORTS.value)); db.commit()
    s = _suggestion(db, project, process, version, "recite_node", {
        "node_id": str(n1.id), "add_claim_ids": [str(claim.id)], "remove_claim_ids": [str(other.id)],
    })
    proc_api.apply_suggestion(db, s); db.commit()
    links = {l.claim_id for l in db.scalars(select(NodeClaimLink).where(NodeClaimLink.node_id == n1.id)).all()}
    assert claim.id in links and other.id not in links
    db.refresh(s)
    assert s.status == "accepted"


def test_apply_recite_node_target_gone(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "recite_node", {
        "node_id": str(uuid4()), "add_claim_ids": [str(claim.id)], "remove_claim_ids": [],
    })
    proc_api.apply_suggestion(db, s); db.commit()
    db.refresh(s)
    assert s.status == "rejected" and s.payload["outcome"] == "target_gone"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_reconcile_apply.py -v`
Expected: FAIL — `apply_suggestion` raises 422 on `add_step` (unknown op) / no `add_step` branch yet.

- [ ] **Step 3: Extend the dispatcher**

In `backend/app/api/v2/processes.py`, locate `apply_suggestion(db, suggestion)`. Confirm its imports include `ProcessNode`, `ProcessLane`, `NodeClaimLink`, `ClaimLinkKind`, and `flag_modified` (add any missing). Import the extracted helper:

```python
from app.api.v2.process_maps import _create_proposed_step
```

Add a small stale-target helper near the top of `processes.py` (module scope):

```python
def _mark_target_gone(suggestion) -> None:
    """Record a graceful no-op when a reconcile op's node/claim target was
    deleted before accept. Marks the suggestion rejected with an outcome key so
    the inbox can explain why nothing happened."""
    suggestion.status = "rejected"
    payload = dict(suggestion.payload or {})
    payload["outcome"] = "target_gone"
    suggestion.payload = payload
    flag_modified(suggestion, "payload")
```

Inside `apply_suggestion`, **before** the final `raise HTTPException(status_code=422, ...)` for unknown ops, add the two branches (the dispatcher already sets `status='accepted'` and `resolved_at` for handled ops on success — mirror whatever the existing `create_process`/`assign_claims` branches do; the snippets below set `status` explicitly):

```python
    if suggestion.op == "add_step":
        p = suggestion.payload or {}
        version = db.get(ProcessVersion, suggestion.version_id)
        source = db.get(ProcessNode, UUID(p["after_node_id"])) if p.get("after_node_id") else None
        if version is None or source is None or source.version_id != version.id:
            _mark_target_gone(suggestion)
            return
        # Resolve lane: prefer the source node's lane (reconcile keeps it in-lane).
        lane_id = source.lane_id
        if lane_id is None:
            # Fall back to the version's first lane by order.
            lane = db.scalars(
                select(ProcessLane).where(ProcessLane.version_id == version.id).order_by(ProcessLane.order_index)
            ).first()
            if lane is None:
                _mark_target_gone(suggestion)
                return
            lane_id = lane.id
        cited = [UUID(c) for c in p.get("cited_claim_ids", [])]
        size_x = float((source.position or {}).get("x", 0)) + 250.0
        _create_proposed_step(
            db,
            version_id=version.id,
            source=source,
            lane_id=lane_id,
            name=p.get("name", ""),
            node_type=p.get("type", "task"),
            x=size_x,
            relative_y=float((source.position or {}).get("relative_y", 0)),
            edge_label=p.get("edge_label"),
            cited_claim_ids=cited,
            project_id=suggestion.project_id,
        )
        suggestion.status = "accepted"
        return

    if suggestion.op == "recite_node":
        p = suggestion.payload or {}
        node = db.get(ProcessNode, UUID(p["node_id"])) if p.get("node_id") else None
        version = db.get(ProcessVersion, suggestion.version_id)
        if node is None or version is None or node.version_id != version.id:
            _mark_target_gone(suggestion)
            return
        for cid in p.get("add_claim_ids", []):
            claim_uuid = UUID(cid)
            exists = db.scalars(
                select(NodeClaimLink).where(
                    NodeClaimLink.node_id == node.id, NodeClaimLink.claim_id == claim_uuid
                )
            ).first()
            if exists is None and db.get(Claim, claim_uuid) is not None:
                db.add(NodeClaimLink(node_id=node.id, claim_id=claim_uuid, link_kind=ClaimLinkKind.SUPPORTS.value))
        for cid in p.get("remove_claim_ids", []):
            link = db.scalars(
                select(NodeClaimLink).where(
                    NodeClaimLink.node_id == node.id, NodeClaimLink.claim_id == UUID(cid)
                )
            ).first()
            if link is not None:
                db.delete(link)
        suggestion.status = "accepted"
        return
```

> `apply_suggestion`'s caller (the `/accept` endpoint) owns the commit — these branches mutate and set `status` but do not commit, matching the existing dispatch branches. Confirm `Claim`, `ProcessVersion`, `UUID`, and `select` are imported in `processes.py`; add any missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_reconcile_apply.py -v`
Expected: PASS (add_step + add_step-target-gone + recite add/remove + recite-target-gone).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/processes.py backend/tests/test_reconcile_apply.py
git commit -m "$(printf 'feat(sp7c): apply_suggestion add_step + recite_node (with target_gone no-op)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 7: Extend `apply_suggestion` — `flag_stale_node` + `relabel_node`

`flag_stale_node` sets `node.properties["evidence_stale"]=True` (non-destructive; the canvas reads it). `relabel_node` updates `node.name`. Both no-op + `target_gone` when the node is gone.

**Files:**
- Modify: `backend/app/api/v2/processes.py` (two more branches)
- Test: `backend/tests/test_reconcile_apply.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_reconcile_apply.py`:

```python
def test_apply_flag_stale_node(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "flag_stale_node", {
        "node_id": str(n1.id), "vanished_claim_ids": [str(claim.id)],
    })
    proc_api.apply_suggestion(db, s); db.commit()
    db.refresh(n1)
    assert n1.properties["evidence_stale"] is True
    # Pre-existing properties are preserved (lineage key untouched here, but the
    # round-trip must not clobber other keys).
    db.refresh(s)
    assert s.status == "accepted"


def test_apply_flag_stale_node_preserves_properties(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    n1.properties = {"_lineage_id": str(n1.id), "ai_proposed": True}
    db.commit()
    s = _suggestion(db, project, process, version, "flag_stale_node", {"node_id": str(n1.id), "vanished_claim_ids": []})
    proc_api.apply_suggestion(db, s); db.commit()
    db.refresh(n1)
    assert n1.properties["evidence_stale"] is True
    assert n1.properties["_lineage_id"] == str(n1.id)
    assert n1.properties["ai_proposed"] is True


def test_apply_relabel_node(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "relabel_node", {
        "node_id": str(n1.id), "proposed_name": "Receive purchase order",
    })
    proc_api.apply_suggestion(db, s); db.commit()
    db.refresh(n1)
    assert n1.name == "Receive purchase order"
    db.refresh(s)
    assert s.status == "accepted"


def test_apply_relabel_node_target_gone(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "relabel_node", {
        "node_id": str(uuid4()), "proposed_name": "Nope",
    })
    proc_api.apply_suggestion(db, s); db.commit()
    db.refresh(s)
    assert s.status == "rejected" and s.payload["outcome"] == "target_gone"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_reconcile_apply.py -v`
Expected: FAIL — `apply_suggestion` 422s on `flag_stale_node`/`relabel_node`.

- [ ] **Step 3: Add the two branches**

In `apply_suggestion`, after the `recite_node` branch and before the final 422, add:

```python
    if suggestion.op == "flag_stale_node":
        p = suggestion.payload or {}
        node = db.get(ProcessNode, UUID(p["node_id"])) if p.get("node_id") else None
        if node is None:
            _mark_target_gone(suggestion)
            return
        new_props = dict(node.properties or {})
        new_props["evidence_stale"] = True
        node.properties = new_props
        flag_modified(node, "properties")
        suggestion.status = "accepted"
        return

    if suggestion.op == "relabel_node":
        p = suggestion.payload or {}
        node = db.get(ProcessNode, UUID(p["node_id"])) if p.get("node_id") else None
        if node is None:
            _mark_target_gone(suggestion)
            return
        proposed = (p.get("proposed_name") or "").strip()
        if not proposed:
            _mark_target_gone(suggestion)
            return
        node.name = proposed
        suggestion.status = "accepted"
        return
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_reconcile_apply.py -v`
Expected: PASS (flag + preserve + relabel + relabel-target-gone).

- [ ] **Step 5: Full backend suite**

Run: `cd backend && .venv/bin/pytest -q`
Expected: PASS (all tests green).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v2/processes.py backend/tests/test_reconcile_apply.py
git commit -m "$(printf 'feat(sp7c): apply_suggestion flag_stale_node + relabel_node\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 8: Frontend types + API client

**Files:**
- Modify: `src/lib/types.ts` (reconcile op/payload/batch types)
- Modify: `src/lib/api.ts` (`reconcileMap`)

- [ ] **Step 1: Add types**

In `src/lib/types.ts`, add near the other process/suggestion types:

```typescript
export type ReconcileOp =
  | "add_step"
  | "recite_node"
  | "flag_stale_node"
  | "relabel_node";

export interface ReconcileSuggestion {
  id: UUID;
  batch_id: UUID;
  op: ReconcileOp;
  /** Op-specific payload with resolved UUIDs. See the SP-7c op vocabulary. */
  payload: Record<string, unknown>;
  rationale: string;
  confidence: number | null;
  status: "pending" | "accepted" | "rejected";
}

export interface ReconcileBatch {
  /** null when the delta was empty and no LLM call was made. */
  batch_id: UUID | null;
  version_id: UUID;
  empty: boolean;
  suggestions: ReconcileSuggestion[];
}
```

- [ ] **Step 2: Add the API client function**

In `src/lib/api.ts`, add to the `api` object (near `applyProposedStep`):

```typescript
  reconcileMap: (projectId: UUID, modelId: UUID, versionId: UUID) =>
    request<ReconcileBatch>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/reconcile`,
      { method: "POST", json: {} }
    ),
```

Add `ReconcileBatch` (and any others used) to the `import type { ... } from "@/lib/types"` block at the top of `api.ts`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "$(printf 'feat(sp7c): frontend reconcile types + reconcileMap client fn\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 9: Pure mapping — reconcile payloads → display rows

The "Refresh" tab feeds `suggestion-inbox.tsx`, which renders generic per-item rows with accept/reject. A pure `.ts` module maps each persisted reconcile payload to a `{ title, detail }` display row, so the inbox can show human-readable text without knowing the op vocabulary. This is the only Vitest-able logic in the frontend slice.

**Files:**
- Create: `src/components/canvas/reconcile.ts`
- Test: `src/components/canvas/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/reconcile.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { reconcileRow } from "./reconcile";
import type { ReconcileSuggestion } from "@/lib/types";

function sug(op: ReconcileSuggestion["op"], payload: Record<string, unknown>): ReconcileSuggestion {
  return {
    id: "s" as never,
    batch_id: "b" as never,
    op,
    payload,
    rationale: "because",
    confidence: 0.7,
    status: "pending",
  };
}

describe("reconcileRow", () => {
  it("describes add_step", () => {
    const row = reconcileRow(sug("add_step", { name: "Verify budget", cited_claim_ids: ["c1", "c2"] }));
    expect(row.title).toBe("Add step: Verify budget");
    expect(row.detail).toContain("2 cited claim");
  });

  it("describes recite_node with add/remove counts", () => {
    const row = reconcileRow(sug("recite_node", { add_claim_ids: ["a"], remove_claim_ids: ["x", "y"] }));
    expect(row.title).toBe("Update citations");
    expect(row.detail).toContain("+1");
    expect(row.detail).toContain("-2");
  });

  it("describes flag_stale_node", () => {
    const row = reconcileRow(sug("flag_stale_node", { vanished_claim_ids: ["a", "b", "c"] }));
    expect(row.title).toBe("Flag evidence stale");
    expect(row.detail).toContain("3");
  });

  it("describes relabel_node", () => {
    const row = reconcileRow(sug("relabel_node", { proposed_name: "Receive PO" }));
    expect(row.title).toBe("Relabel: Receive PO");
  });

  it("falls back gracefully on unknown payload", () => {
    const row = reconcileRow(sug("add_step", {}));
    expect(row.title).toBe("Add step: (unnamed)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/canvas/reconcile.test.ts`
Expected: FAIL — cannot resolve `./reconcile`.

- [ ] **Step 3: Write the module**

Create `src/components/canvas/reconcile.ts`:

```typescript
/** Pure mapping of persisted SP-7c reconcile suggestions to display rows for
 * the suggestion inbox. The inbox stays op-agnostic; this turns each op's
 * resolved payload into a human-readable title + detail line. */
import type { ReconcileSuggestion } from "@/lib/types";

export interface ReconcileRow {
  title: string;
  detail: string;
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

export function reconcileRow(s: ReconcileSuggestion): ReconcileRow {
  const p = s.payload ?? {};
  switch (s.op) {
    case "add_step": {
      const name = typeof p.name === "string" && p.name.trim() ? p.name : "(unnamed)";
      const cited = asIds(p.cited_claim_ids).length;
      return {
        title: `Add step: ${name}`,
        detail: `${cited} cited claim${cited === 1 ? "" : "s"}`,
      };
    }
    case "recite_node": {
      const add = asIds(p.add_claim_ids).length;
      const remove = asIds(p.remove_claim_ids).length;
      return { title: "Update citations", detail: `+${add} / -${remove} claim links` };
    }
    case "flag_stale_node": {
      const n = asIds(p.vanished_claim_ids).length;
      return {
        title: "Flag evidence stale",
        detail: `${n} cited claim${n === 1 ? "" : "s"} left this process`,
      };
    }
    case "relabel_node": {
      const name = typeof p.proposed_name === "string" ? p.proposed_name : "(unnamed)";
      return { title: `Relabel: ${name}`, detail: "Rename the step to match its claims" };
    }
    default:
      return { title: "Reconcile change", detail: "" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/canvas/reconcile.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/reconcile.ts src/components/canvas/reconcile.test.ts
git commit -m "$(printf 'feat(sp7c): pure reconcile-payload->display-row mapping\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 10: `evidence_stale` badge on canvas nodes

`flag_stale_node` writes `properties.evidence_stale=true`; the canvas already round-trips `properties` JSONB. Add a frontend-read-only badge keyed off it, mirroring how `aiProposed` and `issueLevel` already render in `NodeShape`.

**Files:**
- Modify: `src/components/canvas/types.ts` (`CanvasNode.evidenceStale`)
- Modify: `src/components/canvas/layout.ts:130-131` (map the property)
- Modify: `src/components/canvas/shapes.tsx` (`NodeShape` badge)
- Test: `src/components/canvas/layout.test.ts` (extend — proves the mapping)

- [ ] **Step 1: Write the failing test**

Append to `src/components/canvas/layout.test.ts` (the file from sp5a Task 9; its `graphWith` helper builds a one-node graph from `properties`):

```typescript
describe("buildCanvasState evidence_stale", () => {
  it("maps properties.evidence_stale onto the node", () => {
    const { nodes } = buildCanvasState(graphWith({ evidence_stale: true }));
    expect(nodes[0].evidenceStale).toBe(true);
  });

  it("defaults evidenceStale to false when absent", () => {
    const { nodes } = buildCanvasState(graphWith({}));
    expect(nodes[0].evidenceStale).toBe(false);
  });
});
```

> If `graphWith` is not exported/shared, copy its small body into this block as a local helper (sp5a defined it inline in `layout.test.ts`). Do not leave a placeholder.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/canvas/layout.test.ts`
Expected: FAIL — `evidenceStale` is `undefined` on `CanvasNode`.

- [ ] **Step 3: Extend `CanvasNode`, the mapper, and `NodeShape`**

In `src/components/canvas/types.ts`, add to `CanvasNode` (after `description?: string;`):

```typescript
  /** True when SP-7c reconcile flagged this node's evidence as stale
   * (properties.evidence_stale). Frontend-read-only badge. */
  evidenceStale?: boolean;
```

In `src/components/canvas/layout.ts`, in the `graph.nodes.map(...)` return object (after the `description:` line at 131), add:

```typescript
      evidenceStale: (n.properties as { evidence_stale?: boolean } | null)?.evidence_stale === true,
```

In `src/components/canvas/shapes.tsx`, inside `NodeShape`, render the badge. After the existing `issueLevel` badge `<g>` block (the one starting at line 317), add a stale badge that sits on the opposite top corner so it never overlaps the issue badge:

```tsx
      {node.evidenceStale && (
        <g transform={`translate(8, -8)`} style={{ pointerEvents: "none" }}>
          <circle r={8} fill="#f59e0b" stroke="#fff" strokeWidth={2} />
          <text textAnchor="middle" y={3.5} fontSize="10" fontWeight="700" fill="#fff">
            !
          </text>
          <title>Evidence stale — refresh from claims</title>
        </g>
      )}
```

`ResolvedNode = Omit<CanvasNode, "relativeY"> & { y }`, so `evidenceStale` flows to `NodeShape` automatically (verify `renderNodes` in `bpmn-canvas.tsx` spreads `...n` — it does at the mapping site; if it lists fields explicitly add `evidenceStale: n.evidenceStale`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/canvas/layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + canvas suite**

Run: `npx tsc --noEmit && npm test -- src/components/canvas`
Expected: PASS (existing canvas tests still green; the badge is a visual change verified in live smoke).

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/types.ts src/components/canvas/layout.ts src/components/canvas/shapes.tsx src/components/canvas/layout.test.ts
git commit -m "$(printf 'feat(sp7c): evidence_stale badge on canvas nodes\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 11: "Refresh from claims" tab in the right panel

The right panel has tabs `chat | versions | issues | review | sources` (`right-panel.tsx:50-58`). Add a sixth **Refresh** tab. It POSTs to `reconcileMap` on demand, shows "Map is in sync" on an empty batch, and otherwise renders the batch through `<SuggestionInbox>` (the reusable component from sp7b). Accept/reject route to the existing per-suggestion endpoints; on accept, invalidate the version graph query so the canvas re-renders (new node / relabel / stale badge appears).

**Files:**
- Modify: `src/components/canvas/right-panel.tsx` (new tab id, icon, body)

- [ ] **Step 1: Add the tab id, label, and icon**

In `right-panel.tsx`:
- Extend `type TabId` (line 50) to `... | "refresh"`.
- Add to `TAB_LABELS` (line 52): `refresh: "Refresh",`.
- Add `RefreshCw` to the `lucide-react` import (line 15-27).
- Add `{ id: "refresh" }` to the `tabs` array (line 115-121).
- Add a `case "refresh": return <RefreshCw {...props} />;` to `TabIcon` (line 266-280).

- [ ] **Step 2: Add the tab body**

In the tab-body block (after the `sources` case, line 258-260), add:

```tsx
        {tab === "refresh" && (
          <RefreshTab projectId={projectId} modelId={modelId} versionId={versionId} />
        )}
```

Then add the `RefreshTab` component near the other tab components. It imports `useMutation`/`useQueryClient` (already imported at line 35), `reconcileRow` from `./reconcile`, and `SuggestionInbox` from `@/components/inventory/suggestion-inbox`:

```tsx
import { reconcileRow } from "./reconcile";
import { SuggestionInbox } from "@/components/inventory/suggestion-inbox";
import type { ReconcileBatch } from "@/lib/types";

// ─── Refresh-from-claims tab ────────────────────────────────
function RefreshTab({
  projectId,
  modelId,
  versionId,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
}) {
  const queryClient = useQueryClient();
  const [batch, setBatch] = useState<ReconcileBatch | null>(null);

  const reconcile = useMutation({
    mutationFn: () => api.reconcileMap(projectId, modelId, versionId),
    onSuccess: (data) => setBatch(data),
  });

  // After an accept/reject the canvas graph may have changed; re-pull it.
  const invalidateGraph = () =>
    queryClient.invalidateQueries({
      queryKey: ["version-graph", projectId, modelId, versionId],
    });

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-slate-200 p-3">
        <button
          type="button"
          onClick={() => reconcile.mutate()}
          disabled={reconcile.isPending}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:bg-slate-300"
        >
          <RefreshCw size={11} className={reconcile.isPending ? "animate-spin" : ""} />
          {reconcile.isPending ? "Checking claims…" : "Refresh from claims"}
        </button>
        {reconcile.isError && (
          <p className="mt-2 text-[11px] text-rose-600">
            {(reconcile.error as Error).message}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {!batch && !reconcile.isPending && (
          <p className="text-[11px] text-slate-500">
            Compare this map against its process&apos;s claims and propose
            targeted updates. Layout and hand edits are preserved.
          </p>
        )}
        {batch?.empty && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
            Map is in sync with its claims — nothing to reconcile.
          </div>
        )}
        {batch && !batch.empty && (
          <SuggestionInbox
            projectId={projectId}
            suggestions={batch.suggestions}
            describe={reconcileRow}
            onResolved={invalidateGraph}
          />
        )}
      </div>
    </div>
  );
}
```

> Match `<SuggestionInbox>`'s real prop contract from sp7b (`src/components/inventory/suggestion-inbox.tsx`) — read it before wiring. It already owns the accept/reject mutations against `/process-suggestions/{id}/accept|reject`; pass it the suggestions plus a `describe` row-mapper and an `onResolved` callback. If its prop names differ (e.g. `items`, `renderRow`, `onAccepted`), adapt the call site to them rather than inventing new props. The `["version-graph", ...]` query key must match the key the version page uses to load the graph — grep `useQuery` in `src/app/(canvas)/.../versions/[versionId]/page.tsx` and use the exact key.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/right-panel.tsx
git commit -m "$(printf 'feat(sp7c): Refresh-from-claims tab reusing SuggestionInbox\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 12: Full verification + live smoke

**Files:**
- Modify: `docs/superpowers/plans/2026-06-11-sp7c-map-reconcile.md` (append an "Execution outcome" section)

- [ ] **Step 1: Backend gate**

Run: `cd backend && .venv/bin/pytest -q`
Expected: PASS (all tests incl. `test_map_reconcile.py` and `test_reconcile_apply.py`).

- [ ] **Step 2: Frontend gates**

Run: `npx tsc --noEmit`
Expected: PASS.
Run: `npm test`
Expected: PASS (Vitest green, incl. `reconcile.test.ts` and the extended `layout.test.ts`).

- [ ] **Step 3: Live smoke (best-effort — requires a real key + dev DB at head)**

If `backend/.env` has a real `ANTHROPIC_API_KEY`, bring the stack up (`./run-local.sh status`; start if needed). On a project with a mapped process:
1. **New evidence → add_step.** Assign a new claim to the mapped process (Processes page triage), open the map, open the **Refresh** tab → "Refresh from claims". Confirm a batch appears; accept an `add_step` card → a violet, dashed, ✦-badged node appears downstream with the cited claim linked. Reload the page → the inbox state persisted (the accepted item is gone; remaining pending items survive).
2. **Vanished evidence → stale badge.** Delete (or unlink from the process) a claim a node cites, then "Refresh from claims" → accept the `flag_stale_node` (or `recite_node` removing it) → the node shows the amber `!` evidence-stale badge (flag) or its citation count drops (recite).
3. **Empty delta.** With the map in sync, "Refresh from claims" → "Map is in sync" message, **no LLM call** (confirm in backend logs that no reconcile request was sent).
4. **Stale target.** Open the Refresh batch, delete the target node from the canvas, then accept that node's suggestion → graceful no-op; the item shows the `target_gone` outcome (rejected), nothing else changes.

If the key is blank, record that the endpoint returns 503 by design and live smoke is deferred — delta, dispatch, and ref-hygiene paths are covered by automated tests, and the empty-delta short-circuit needs no key.

- [ ] **Step 4: Record the outcome + commit**

Append an "## Execution outcome" section documenting: gate results (pytest/tsc/vitest counts), live-smoke result or deferral, deviations from the plan (especially any sp7b model/prop-name adjustments and the real `<SuggestionInbox>` prop contract), and follow-ups. Commit:

```bash
git add docs/superpowers/plans/2026-06-11-sp7c-map-reconcile.md
git commit -m "$(printf 'docs(sp7c): record map-reconcile execution outcome\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Verification

- **pytest** (`cd backend && .venv/bin/pytest -q`): all green, including
  - `test_map_reconcile.py` — `compute_claim_delta` (new + vanished, empty-when-in-sync); op vocabulary + batch schemas; `propose_reconcile` faked-client parse + malformed-degrades-to-empty + no-key RuntimeError; endpoint empty-delta-no-LLM-no-persist, persist+ref-resolution (fabricated node ref dropped), 409 (no process_id), 503 (LLM failure, nothing persisted).
  - `test_reconcile_apply.py` — each of the four ops applies; `add_step`/`recite_node`/`relabel_node` target-gone → `status='rejected'` + `payload["outcome"]="target_gone"`; `flag_stale_node` preserves other `properties` keys.
  - `test_ai_edit.py` — `apply_proposed_step` still green after the `_create_proposed_step` extraction (regression gate).
- **tsc** (`npx tsc --noEmit`): clean.
- **Vitest** (`npm test`): green, including `reconcile.test.ts` (payload→row mapping for all four ops + graceful fallback) and `layout.test.ts` (`evidence_stale` mapping).
- **Manual smoke:** assign a new claim to a mapped process → Refresh from claims → accept `add_step` → node appears downstream with its citation; delete a cited claim → Refresh → accept flag → amber evidence-stale badge appears; in-sync map → Refresh → "Map is in sync" with no LLM call.

---

## Self-review notes (resolved during planning)

- **No new migration.** `flag_stale_node` reuses `process_nodes.properties` JSONB — the same column `ai_proposed`/`description` already round-trip through (`process_maps.py:531`, `:1298`). The persisted suggestions use the sp7b `process_suggestions` table verbatim (`kind='map_reconcile'`, `version_id`/`process_id` set, shared `batch_id`).
- **Empty delta is an explicit no-LLM path** (spec line 228 + error-handling section): the endpoint short-circuits to `ReconcileBatchRead(empty=True, batch_id=None)` before touching the client, and a test asserts the service is never called (`patch.object(..., side_effect=AssertionError)`).
- **Ref hygiene reuses `_resolve_refs`** for claims (`process_maps.py:1161`) and adds the symmetric `_resolve_node_ref` for `N#` refs (inverting `MapContext.node_ref_by_id`). Ops anchored on a fabricated node ref are dropped before persistence — proven by the `N99` case in `test_reconcile_persists_batch_and_resolves_refs`.
- **`add_step` reuse:** `_create_proposed_step` is extracted from the existing endpoint body (Task 4) so the accept path and the ai-proposed-step endpoint share one creation routine — the extraction is behavior-preserving and gated by the existing `test_ai_edit.py`.
- **`target_gone` representation:** one consistent choice — `status='rejected'` + `payload["outcome"]="target_gone"` (a payload key, not a new status value), mirroring the spec's "graceful no-op, marked with a target_gone outcome" (spec line 245).
- **503 vs 502:** the spec's error-handling section says reconcile LLM failures surface as **503** (vs sp5a's 502 for ai-edit); this plan uses 503 to match the spec exactly.
- **Frontend reuse:** the Refresh tab is a thin caller of the existing `<SuggestionInbox>`; the only testable new logic (`reconcile.ts`) is pure and unit-tested, matching the repo's node-environment Vitest convention (no DOM component tests — same call made in the sp5a outcome).
- **Risk — sp7b coupling:** the inventory model module path (`app.models.process_inventory`), `ProcessSuggestion` constructor field names, and `<SuggestionInbox>`'s prop contract are assumed from the spec; every task that touches them carries a "grep/read the real thing first and adapt" note so the implementer reconciles against what sp7b actually shipped rather than guessing.

---

## Execution outcome (2026-06-12)

Executed via subagent-driven development (fresh implementer per task + two-stage spec/code-quality review, controller adjudication) on branch `sp6-source-viewer`, committed locally, **not pushed**. 11 commits `b1d8008..26e9c6b`.

### Gates (all green)
- **Backend** `cd backend && .venv/bin/pytest -q`: **142 passed** (incl. `test_map_reconcile.py` — delta, schemas, `propose_reconcile` faked-client parse/degrade/no-key, endpoint empty-delta-no-LLM / persist+ref-resolution / fabricated-ref drop / recite+flag persist / unknown-op drop / 409 / 503; `test_reconcile_apply.py` — all four ops apply + target-gone + recite idempotency + foreign-project-claim rejection; `test_ai_edit.py` green after the `_create_proposed_step` extraction).
- **tsc** `npx tsc --noEmit`: clean.
- **Vitest** `npm test`: **67 passed / 11 files** (incl. `reconcile.test.ts` 5, the `evidence_stale` cases in `layout.test.ts`).
- Lint advisory only (unchanged baseline). No SP-7c commit included the unrelated working-tree changes (`package.json`/`package-lock.json`/`src/app/layout.tsx`, the `.agents/`/`.codex/`/etc. tool-config dirs).

### Commit map
`b1d8008` delta · `4a3719a` schemas · `a4c0501` propose_reconcile · `26b6325` extract `_create_proposed_step` · `4abc0fd` reconcile endpoint · `c25e460` apply add_step+recite_node · `442faf3` apply flag_stale_node+relabel_node · `162e810` FE types+client · `c4f803f` `reconcileRow` · `9bf2a76` evidence_stale badge · `26e9c6b` Refresh tab.

### Deviations from the plan text (controller-adjudicated, all validated by the final holistic review)
1. **Dispatcher contract.** The plan assumed `apply_suggestion(db, suggestion)` self-mutating `status="rejected"` + `payload["outcome"]`. sp7b actually shipped `apply_suggestion(db, project, sug) -> AcceptSuggestionResult` that **returns** a result (the accept/batch endpoints stamp `status`/`outcome`/`resolved_at`). All four reconcile branches return results; **target-gone = `status="accepted"`, `outcome="target_gone"`** (the real `outcome` column, matching the pre-existing `assign_claims` branch), not the plan's `rejected`+payload-key. Tests adapted to the 3-arg/return contract.
2. **`_create_proposed_step` import** into `processes.py` is module-level (verified no circular import: `process_maps` doesn't import `processes`, and the v2 router loads `process_maps` first).
3. **Uniform version-scoping.** The plan only version-scoped `recite_node`; all four reconcile branches now guard `node.version_id == version.id` for consistency.
4. **`recite_node` add-loop enforces `claim.project_id == project.id`** (parity with `_link_claims`/`_create_proposed_step`), with a foreign-project-claim test.
5. **Refresh tab does NOT reuse `<SuggestionInbox>`.** That component + `groupByBatch` are hardcoded to `ProcessSuggestion` and sort on `created_at` (a field `ReconcileSuggestion` lacks), and reconcile returns a single batch. The tab is a dedicated inline inbox in `right-panel.tsx` that still uses `reconcileRow` and the same `/process-suggestions/{id}/accept|reject` endpoints; `suggestion-inbox.tsx`/`inbox-grouping.ts`/`reconcile.ts` were left untouched, so the Processes page is unaffected. It invalidates the real canvas-graph query key `["graph", projectId, modelId, versionId]` (plan's guessed `["version-graph", …]` was wrong) and surfaces a `target_gone` accept as "No change — target was deleted".
6. **evidence_stale badge placed bottom-right** (`translate(w-8, h+8)`): both top corners were taken (issueLevel top-right, reviewBadge top-left); the plan's suggested `translate(8,-8)` would have collided with the review badge.
7. **Plan import note corrected**: `uuid4` was NOT already imported in `process_maps.py` (only `UUID`); added it. `_NODE_REF` (dead) and the `patch` import (until needed) were omitted.

### Follow-ups (non-blocking)
- `add_step` persists `lane_ref`/`lane_name` in the suggestion payload but the dispatcher derives the lane from the source node and never reads them — harmless dead keys, preserved for a possible future lane-aware accept.
- Live smoke **deferred**: this WSL environment can't reach the Windows-hosted dev servers, and "Refresh from claims" needs a real `ANTHROPIC_API_KEY`. The empty-delta short-circuit (no key needed), delta computation, ref hygiene, dispatch, and all four apply paths are covered by automated tests; the LLM-failure path is the documented 503. The end-to-end UI smoke (assign a new claim → Refresh → accept add_step → node appears; delete a cited claim → Refresh → accept flag → amber badge; in-sync map → "Map is in sync"; stale target → "No change — target was deleted") remains to run on the Windows dev stack.
