# Require a Reason on Delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make deleting a step, connection, or lane require a reason — a hard 422, mirroring the
existing rename / lane-move rule — and record that reason on the resulting `change_event`.

**Architecture:** A shared `DeleteRequest` JSON body (`reason`, `ai_applied`) on all three delete
endpoints, gated by one helper that raises 422 before any mutation. On the client, the three delete
implementations become pure and reason-taking, with prompting lifted into wrappers over the
existing `ReasonPromptDialog` (new destructive variant). AI-applied deletes, undo-of-create, redo,
and paste-undo supply their reason programmatically and never prompt.

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic v2 (backend, pytest against real Postgres);
Next.js + React + TypeScript (frontend, vitest).

**Spec:** `docs/superpowers/specs/2026-07-28-require-reason-on-delete-design.md`
**Issue:** #53. **Branch:** `feat/require-reason-on-delete` (already created off `main` @ `c287e26`).

---

## File Structure

**Backend**

| File | Responsibility | Change |
|---|---|---|
| `backend/app/schemas/process_map.py` | request/response shapes | **Modify** — add `DeleteRequest` |
| `backend/app/api/v2/process_maps.py` | map CRUD endpoints | **Modify** — `_require_delete_reason` helper + the three delete endpoints |
| `backend/tests/test_delete_reason.py` | the new rule | **Create** |
| `backend/tests/test_change_event_capture.py` | event-capture coverage | **Modify** — 4 delete tests |
| `backend/tests/test_ai_edit.py` | AI edit coverage | **Modify** — 1 direct `delete_node` call |
| `backend/tests/test_stakeholder_review.py` | review lifecycle | **Modify** — 2 `client.delete` calls |

**Frontend**

| File | Responsibility | Change |
|---|---|---|
| `src/components/canvas/delete-reason.ts` | prompt copy for deletes — pure | **Create** |
| `src/components/canvas/delete-reason.test.ts` | its tests | **Create** |
| `src/components/canvas/use-reason-prompt.ts` | reason-prompt state | **Modify** — destructive + description options |
| `src/components/canvas/reason-prompt-dialog.tsx` | the modal | **Modify** — destructive rendering |
| `src/components/canvas/suggestion-apply.ts` | op → step planning — pure | **Modify** — delete steps carry `reason` |
| `src/components/canvas/suggestion-apply.test.ts` | its tests | **Modify** — assert delete steps get a reason |
| `src/lib/types.ts` | wire types | **Modify** — add `DeleteRequest` |
| `src/lib/api.ts` | API client | **Modify** — 3 delete signatures |
| `src/lib/api-delete.test.ts` | delete request shape | **Create** |
| `src/components/canvas/bpmn-canvas.tsx` | the canvas | **Modify** — impls take a reason; wrappers prompt; all call sites |

`delete-reason.ts` is a separate module for the same reason `selection.ts` and `suggestion-apply.ts`
are: `bpmn-canvas.tsx` is ~2700 lines and cannot be unit-tested without rendering an SVG, so any
logic worth asserting lives outside it.

**Ordering rationale.** Backend first (Tasks 1–3), each green on its own. Then the three additive,
independently-green frontend modules (Tasks 4–6). The `api.ts` signature change and every
`bpmn-canvas.tsx` call site land together in Task 7, because TypeScript will not compile between
those two edits — splitting them would mean knowingly committing a red tree.

---

### Task 1: Backend — `DeleteRequest`, the gate helper, and `delete_edge`

**Files:**
- Modify: `backend/app/schemas/process_map.py` (after `EdgeUpdate`, ~line 107)
- Modify: `backend/app/api/v2/process_maps.py:1136-1162`
- Create: `backend/tests/test_delete_reason.py`
- Modify: `backend/tests/test_change_event_capture.py:398-421`

Start the Postgres the tests need before anything else — `./run-local.sh` or the `run-poet-local`
workflow. Every `pytest` command below assumes it is up.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_delete_reason.py`:

```python
"""Deleting a step, connection, or lane requires a reason.

Delete is the most provenance-critical edit in the map — it is the only one that
removes evidence — so it carries the same hard 422 as a rename or a lane move.
These tests pin the rule itself; `test_change_event_capture.py` pins the events
the deletes write.
"""
import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import process_maps as pm_api
from app.models.change_event import ChangeEvent
from app.models.process import ProcessEdge
from app.schemas.process_map import DeleteRequest, LaneCreate
from tests.test_ai_edit import _seed_version_for_endpoint
from tests.test_change_event_capture import _seed_edge


def _events_for(db, target_id):
    return list(db.scalars(select(ChangeEvent).where(ChangeEvent.target_id == target_id)).all())


# --- edge ------------------------------------------------------------------

@pytest.mark.parametrize(
    "payload",
    [None, DeleteRequest(), DeleteRequest(reason=""), DeleteRequest(reason="   ")],
    ids=["no_body", "empty_payload", "empty_reason", "whitespace_reason"],
)
def test_delete_edge_without_reason_is_rejected(db, payload):
    project, version, n1, _claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    with pytest.raises(HTTPException) as exc:
        pm_api.delete_edge(project=project, edge_id=edge.id, db=db, payload=payload)
    assert exc.value.status_code == 422
    assert exc.value.detail == "A reason is required to delete a connection."
    # The edge survives and nothing was logged — a gate that ran after
    # record_change would leave a phantom delete in the change log.
    assert db.get(ProcessEdge, edge.id) is not None
    assert [e for e in _events_for(db, edge.id) if e.kind == "delete"] == []


def test_delete_edge_with_reason_records_it(db):
    project, version, n1, _claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    pm_api.delete_edge(
        project=project,
        edge_id=edge.id,
        db=db,
        payload=DeleteRequest(reason="  Superseded by the direct route  "),
    )
    events = [e for e in _events_for(db, edge.id) if e.kind == "delete"]
    assert len(events) == 1
    ev = events[0]
    assert ev.reason == "Superseded by the direct route"  # stored trimmed
    assert ev.source == "manual"
    assert ev.actor_kind == "user"
    assert db.get(ProcessEdge, edge.id) is None


def test_delete_edge_ai_applied_records_chat_source_and_ai_actor(db):
    project, version, n1, _claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    pm_api.delete_edge(
        project=project,
        edge_id=edge.id,
        db=db,
        payload=DeleteRequest(reason="Removed per the SOP", ai_applied=True),
    )
    ev = [e for e in _events_for(db, edge.id) if e.kind == "delete"][0]
    assert ev.reason == "Removed per the SOP"
    assert ev.source == "chat"
    assert ev.actor_kind == "ai"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_delete_reason.py -v`
Expected: collection error — `ImportError: cannot import name 'DeleteRequest' from
'app.schemas.process_map'`.

- [ ] **Step 3: Add the `DeleteRequest` schema**

In `backend/app/schemas/process_map.py`, immediately after the `EdgeUpdate` class:

```python
class DeleteRequest(BaseModel):
    """Body for the node / edge / lane delete endpoints.

    `reason` is required in practice — the handlers reject a missing or blank one
    with a 422 — but it is declared optional here so that rejection carries our
    own message instead of a pydantic validation envelope. Same trick, and same
    motivation, as `NodeUpdate` / `EdgeUpdate` / `LaneUpdate`.
    """

    reason: str | None = Field(default=None, max_length=2000)
    ai_applied: bool = False
```

- [ ] **Step 4: Add the gate helper and wire up `delete_edge`**

In `backend/app/api/v2/process_maps.py`, add `Body` to the fastapi import (line 7):

```python
from fastapi import APIRouter, Body, Depends, HTTPException, status
```

Add `DeleteRequest` to the `app.schemas.process_map` import block (alphabetically, after
`CitationDetail` / before `EdgeCreate` — the block is sorted).

Insert the helper immediately above the `@router.delete("/edges/{edge_id}"...)` decorator:

```python
def _require_delete_reason(
    payload: DeleteRequest | None, message: str
) -> tuple[str, bool]:
    """Return the trimmed delete reason and the ai_applied flag.

    Raises 422 with `message` when the reason is missing or blank. Call this
    before any session mutation — it does not roll back.
    """
    reason = (payload.reason or "").strip() if payload else ""
    if not reason:
        raise HTTPException(status_code=422, detail=message)
    return reason, payload.ai_applied
```

It returns the flag as well as the reason so the caller's `payload` doesn't stay typed
`DeleteRequest | None` past the gate — otherwise every one of the three endpoints needs a
`payload.ai_applied if payload else False` whose `else` branch is unreachable.

Then replace the body of `delete_edge` (currently `process_maps.py:1136-1162`) with:

```python
@router.delete("/edges/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_edge(
    project: Annotated[Project, Depends(get_project_or_404)],
    edge_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    payload: Annotated[DeleteRequest | None, Body()] = None,
) -> None:
    edge = db.get(ProcessEdge, edge_id)
    if edge is None:
        raise HTTPException(status_code=404, detail="Edge not found")
    _check_edge_in_project(edge, project.id, db)
    reason, ai_applied = _require_delete_reason(
        payload, "A reason is required to delete a connection."
    )
    record_change(
        db,
        target_type=ChangeTargetType.EDGE.value,
        target_id=edge.id,
        model_id=model_id_for_version(db, edge.version_id),
        version_id=edge.version_id,
        kind=ChangeKind.DELETE.value,
        reason=reason,
        before={
            "source_node_id": str(edge.source_node_id),
            "target_node_id": str(edge.target_node_id),
            "label": edge.label,
        },
        source=ChangeSource.CHAT.value if ai_applied else ChangeSource.MANUAL.value,
        actor_kind=ChangeActorKind.AI.value if ai_applied else ChangeActorKind.USER.value,
    )
    db.delete(edge)
    db.commit()
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_delete_reason.py -v`
Expected: 5 passed (3 parametrized rejections + 2 accept cases).

- [ ] **Step 6: Fix the existing edge-delete test**

`backend/tests/test_change_event_capture.py:406` calls `pm_api.delete_edge` with no payload and
now raises. Change that line to:

```python
    pm_api.delete_edge(
        project=project,
        edge_id=edge_id,
        db=db,
        payload=DeleteRequest(reason="No longer part of the flow"),
    )
```

and add an assertion after the existing `assert ev.source == "manual"`:

```python
    assert ev.reason == "No longer part of the flow"
```

Add `DeleteRequest` to that file's `app.schemas.process_map` import on line 11.

- [ ] **Step 7: Run the affected suites**

Run: `cd backend && python -m pytest tests/test_delete_reason.py tests/test_change_event_capture.py -v`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add backend/app/schemas/process_map.py backend/app/api/v2/process_maps.py \
        backend/tests/test_delete_reason.py backend/tests/test_change_event_capture.py
git commit -m "feat(provenance): require a reason to delete an edge

Adds the shared DeleteRequest body and the _require_delete_reason gate,
mirroring the 422 the edit paths already raise. The reason replaces the
hardcoded \"Deleted\" on the change_event, and ai_applied now distinguishes an
AI delete from a hand delete.

Refs #53"
```

---

### Task 2: Backend — `delete_node`

**Files:**
- Modify: `backend/app/api/v2/process_maps.py:1165-1203`
- Modify: `backend/tests/test_delete_reason.py`
- Modify: `backend/tests/test_change_event_capture.py:373-395`
- Modify: `backend/tests/test_ai_edit.py:266`
- Modify: `backend/tests/test_stakeholder_review.py:138,160`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_delete_reason.py`:

```python
# --- node ------------------------------------------------------------------

@pytest.mark.parametrize(
    "payload",
    [None, DeleteRequest(), DeleteRequest(reason=""), DeleteRequest(reason="   ")],
    ids=["no_body", "empty_payload", "empty_reason", "whitespace_reason"],
)
def test_delete_node_without_reason_is_rejected(db, payload):
    project, _version, n1, _claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.delete_node(project=project, node_id=n1.id, db=db, payload=payload)
    assert exc.value.status_code == 422
    # Pin the whole string, not a substring: a copied "connection" message here
    # would keep the suite green while telling the user the wrong noun.
    assert exc.value.detail == "A reason is required to delete a step."
    assert db.get(ProcessNode, n1.id) is not None
    assert [e for e in _events_for(db, n1.id) if e.kind == "delete"] == []


def test_rejected_node_delete_leaves_review_rows_intact(db):
    """The gate runs before the Review cleanup, so a rejected delete must not
    have stripped the node's review rows on its way to the 422."""
    project, _version, n1, _claim = _seed_version_for_endpoint(db)
    db.add(Review(
        target_type=ReviewTargetType.PROCESS_NODE.value,
        target_id=n1.id,
        status="approved",
    ))
    db.commit()
    with pytest.raises(HTTPException):
        pm_api.delete_node(project=project, node_id=n1.id, db=db, payload=None)
    db.expire_all()
    rows = db.scalars(
        select(Review).where(
            Review.target_type == ReviewTargetType.PROCESS_NODE.value,
            Review.target_id == n1.id,
        )
    ).all()
    assert len(list(rows)) == 1


def test_delete_node_with_reason_records_it(db):
    project, _version, n1, _claim = _seed_version_for_endpoint(db)
    node_id = n1.id
    pm_api.delete_node(
        project=project,
        node_id=node_id,
        db=db,
        payload=DeleteRequest(reason="  Duplicate of the intake step  "),
    )
    events = [e for e in _events_for(db, node_id) if e.kind == "delete"]
    assert len(events) == 1
    ev = events[0]
    assert ev.reason == "Duplicate of the intake step"
    assert ev.source == "manual"
    assert ev.actor_kind == "user"
    assert db.get(ProcessNode, node_id) is None


def test_delete_node_ai_applied_records_chat_source_and_ai_actor(db):
    project, _version, n1, _claim = _seed_version_for_endpoint(db)
    node_id = n1.id
    pm_api.delete_node(
        project=project,
        node_id=node_id,
        db=db,
        payload=DeleteRequest(reason="Not supported by any source", ai_applied=True),
    )
    ev = [e for e in _events_for(db, node_id) if e.kind == "delete"][0]
    assert ev.reason == "Not supported by any source"
    assert ev.source == "chat"
    assert ev.actor_kind == "ai"
```

Extend the imports at the top of the file:

```python
from app.enums import ReviewTargetType
from app.models.process import ProcessEdge, ProcessNode
from app.models.workflow import Review
```

(replacing the existing `from app.models.process import ProcessEdge` line).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_delete_reason.py -v -k node`
Expected: FAIL — `TypeError: delete_node() got an unexpected keyword argument 'payload'`.

- [ ] **Step 3: Wire up `delete_node`**

Replace the signature and the head of `delete_node` (`process_maps.py:1165-1188`):

```python
@router.delete("/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    payload: Annotated[DeleteRequest | None, Body()] = None,
) -> None:
    """Delete a node. FK cascades drop the connected edges and node-claim
    links automatically."""
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)
    reason, ai_applied = _require_delete_reason(
        payload, "A reason is required to delete a step."
    )
    version_id = node.version_id
    record_change(
        db,
        target_type=ChangeTargetType.NODE.value,
        target_id=node.id,
        model_id=model_id_for_version(db, node.version_id),
        version_id=node.version_id,
        kind=ChangeKind.DELETE.value,
        reason=reason,
        before={"name": node.name, "type": node.type},
        source=ChangeSource.CHAT.value if ai_applied else ChangeSource.MANUAL.value,
        actor_kind=ChangeActorKind.AI.value if ai_applied else ChangeActorKind.USER.value,
    )
```

Everything from the `db.execute(delete(Review)...)` call onward is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_delete_reason.py -v`
Expected: all pass.

- [ ] **Step 5: Fix the three existing callers**

`backend/tests/test_change_event_capture.py:381` →

```python
    pm_api.delete_node(
        project=project,
        node_id=node_id,
        db=db,
        payload=DeleteRequest(reason="Step no longer performed"),
    )
```

and add after `assert ev.source == "manual"`:

```python
    assert ev.reason == "Step no longer performed"
```

`backend/tests/test_ai_edit.py:266` →

```python
    pm_api.delete_node(
        project=project,
        node_id=new_id,
        db=db,
        payload=pm_api.DeleteRequest(reason="Cleaning up the proposed step"),
    )
```

(`process_maps` re-exports the schema names it imports, which is how the file already reaches
`pm_api.AiProposedStepRequest` on line 259.)

`backend/tests/test_stakeholder_review.py:138` and `:160` — add a body to each delete.

**`client.delete(url, json=...)` does not work.** `httpx` deliberately omits the body shorthand
from `.delete()` — passing `json=` raises `TypeError: got an unexpected keyword argument 'json'`.
Use the general form:

```python
    d = client.request(
        "DELETE",
        f"/api/v2/projects/{proj.id}/nodes/{nodes[0].id}",
        json={"reason": "Removed during review"},
    )
```

```python
    d = client.request(
        "DELETE",
        f"/api/v2/projects/{proj.id}/nodes/{nodes[1].id}",
        json={"reason": "Removed during review"},
    )
```

(This is a Python-client quirk only — browser `fetch` sends a DELETE body fine, so the frontend
tasks are unaffected. Task 1's wire-level tests in `test_delete_reason.py` use the same
`client.request("DELETE", ...)` form; copy from there.)

- [ ] **Step 6: Run the affected suites**

Run: `cd backend && python -m pytest tests/test_delete_reason.py tests/test_change_event_capture.py tests/test_ai_edit.py tests/test_stakeholder_review.py -v`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/
git commit -m "feat(provenance): require a reason to delete a node

The gate runs before the Review cleanup, so a rejected delete leaves the
node and its review rows untouched — covered by a dedicated test.

Refs #53"
```

---

### Task 3: Backend — `delete_lane`, retiring the `ai_applied` query param

**Files:**
- Modify: `backend/app/api/v2/process_maps.py:1603-1663`
- Modify: `backend/tests/test_delete_reason.py`
- Modify: `backend/tests/test_change_event_capture.py:424-475`

`delete_lane` is the one endpoint that already has half of this: an `ai_applied` **query
parameter** that selects between two canned reason strings, `"Removed by AI suggestion"` and
`"Deleted"`. Both are replaced by the body field and a real reason.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_delete_reason.py`:

```python
# --- lane ------------------------------------------------------------------

def _second_lane(db, project, version):
    """Lanes can only be deleted when another one remains."""
    return pm_api.add_lane(
        project=project,
        model_id=version.model_id,
        version_id=version.id,
        payload=LaneCreate(name="Lane To Delete", order_index=1),
        db=db,
    )


@pytest.mark.parametrize(
    "payload",
    [None, DeleteRequest(), DeleteRequest(reason=""), DeleteRequest(reason="   ")],
    ids=["no_body", "empty_payload", "empty_reason", "whitespace_reason"],
)
def test_delete_lane_without_reason_is_rejected(db, payload):
    project, version, _n1, _claim = _seed_version_for_endpoint(db)
    lane = _second_lane(db, project, version)
    with pytest.raises(HTTPException) as exc:
        pm_api.delete_lane(project=project, lane_id=lane.id, db=db, payload=payload)
    assert exc.value.status_code == 422
    # Pin the whole string — see the note on the node equivalent.
    assert exc.value.detail == "A reason is required to delete a lane."
    assert db.get(ProcessLane, lane.id) is not None
    assert [e for e in _events_for(db, lane.id) if e.kind == "delete"] == []


def test_rejected_lane_delete_leaves_nodes_in_place(db):
    """The gate runs before the fallback-lane reassignment, so a rejected
    delete must not have moved the lane's nodes on its way to the 422."""
    project, version, n1, _claim = _seed_version_for_endpoint(db)
    original_lane_id = n1.lane_id
    _second_lane(db, project, version)
    with pytest.raises(HTTPException):
        pm_api.delete_lane(project=project, lane_id=original_lane_id, db=db, payload=None)
    db.expire_all()
    assert db.get(ProcessNode, n1.id).lane_id == original_lane_id


def test_delete_last_lane_is_rejected_before_the_reason_gate(db):
    """A delete that can never succeed shouldn't first demand a justification."""
    project, version, n1, _claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.delete_lane(project=project, lane_id=n1.lane_id, db=db, payload=None)
    assert exc.value.status_code == 422
    assert exc.value.detail == "Cannot delete the last remaining lane"


def test_delete_lane_with_reason_records_it(db):
    project, version, _n1, _claim = _seed_version_for_endpoint(db)
    lane = _second_lane(db, project, version)
    pm_api.delete_lane(
        project=project,
        lane_id=lane.id,
        db=db,
        payload=DeleteRequest(reason="  Merged into Operations  "),
    )
    events = [e for e in _events_for(db, lane.id) if e.kind == "delete"]
    assert len(events) == 1
    ev = events[0]
    assert ev.reason == "Merged into Operations"
    assert ev.source == "manual"
    assert ev.actor_kind == "user"
    assert db.get(ProcessLane, lane.id) is None


def test_delete_lane_ai_applied_carries_the_suggestion_reason(db):
    """The retired query param picked between two canned strings; an AI lane
    delete now logs the suggestion's own rationale."""
    project, version, _n1, _claim = _seed_version_for_endpoint(db)
    lane = _second_lane(db, project, version)
    pm_api.delete_lane(
        project=project,
        lane_id=lane.id,
        db=db,
        payload=DeleteRequest(reason="No sources place work in this lane", ai_applied=True),
    )
    ev = [e for e in _events_for(db, lane.id) if e.kind == "delete"][0]
    assert ev.reason == "No sources place work in this lane"
    assert ev.source == "chat"
    assert ev.actor_kind == "ai"
```

Extend that file's model import to include `ProcessLane`:

```python
from app.models.process import ProcessEdge, ProcessLane, ProcessNode
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_delete_reason.py -v -k lane`
Expected: FAIL — `TypeError: delete_lane() got an unexpected keyword argument 'payload'`.

- [ ] **Step 3: Wire up `delete_lane`**

Replace the signature (`process_maps.py:1603-1609`) — note `ai_applied: bool = False` is **removed**:

```python
@router.delete("/lanes/{lane_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_lane(
    project: Annotated[Project, Depends(get_project_or_404)],
    lane_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    payload: Annotated[DeleteRequest | None, Body()] = None,
) -> None:
```

Insert the gate immediately after the last-lane guard — that is, after the
`raise HTTPException(status_code=422, detail="Cannot delete the last remaining lane")` block and
before `fallback = others[0]`:

```python
    # Structural impossibility first, provenance second: there's no point
    # demanding a justification for a delete that can never succeed.
    reason, ai_applied = _require_delete_reason(
        payload, "A reason is required to delete a lane."
    )
```

Then replace the three affected lines of the `record_change` call:

```python
        reason=reason,
        before={"name": lane.name},
        source=ChangeSource.CHAT.value if ai_applied else ChangeSource.MANUAL.value,
        actor_kind=ChangeActorKind.AI.value if ai_applied else ChangeActorKind.USER.value,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_delete_reason.py -v`
Expected: all pass.

- [ ] **Step 5: Fix the two existing lane tests**

`backend/tests/test_change_event_capture.py:438` →

```python
    pm_api.delete_lane(
        project=project,
        lane_id=lane_id,
        db=db,
        payload=DeleteRequest(reason="Lane no longer needed"),
    )
```

and add after `assert ev.actor_kind == "user"`:

```python
    assert ev.reason == "Lane no longer needed"
```

`backend/tests/test_change_event_capture.py:468` — the `ai_applied=True` kwarg moves into the body,
and the assertion changes from the retired canned string to the supplied reason:

```python
    pm_api.delete_lane(
        project=project,
        lane_id=lane_id,
        db=db,
        payload=DeleteRequest(reason="Consolidated by suggestion", ai_applied=True),
    )
```

Add after `assert ev.actor_kind == "ai"`:

```python
    assert ev.reason == "Consolidated by suggestion"
```

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && python -m pytest`
Expected: all pass. Any other failure means a delete caller this plan did not find — track it down
before continuing rather than patching around it.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/
git commit -m "feat(provenance): require a reason to delete a lane

Retires the ai_applied query param and the two canned reason strings it chose
between. An AI lane delete now logs the suggestion's own rationale instead of
the fixed \"Removed by AI suggestion\" label.

The last-lane guard stays ahead of the reason gate: a delete that can never
succeed shouldn't first demand a justification.

Refs #53"
```

---

### Task 4: Frontend — the `delete-reason` copy module

**Files:**
- Create: `src/components/canvas/delete-reason.ts`
- Create: `src/components/canvas/delete-reason.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/delete-reason.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deleteActionLabel, deleteActionDescription } from "./delete-reason";

describe("deleteActionLabel", () => {
  it("names a single step and a single connection", () => {
    expect(deleteActionLabel({ nodes: 1, edges: 0 })).toBe("Delete step");
    expect(deleteActionLabel({ nodes: 0, edges: 1 })).toBe("Delete connection");
  });
  it("pluralizes a homogeneous multi-selection", () => {
    expect(deleteActionLabel({ nodes: 3, edges: 0 })).toBe("Delete 3 steps");
    expect(deleteActionLabel({ nodes: 0, edges: 2 })).toBe("Delete 2 connections");
  });
  it("collapses a mixed selection to a total count of items", () => {
    expect(deleteActionLabel({ nodes: 2, edges: 3 })).toBe("Delete 5 items");
    expect(deleteActionLabel({ nodes: 1, edges: 1 })).toBe("Delete 2 items");
  });
});

describe("deleteActionDescription", () => {
  it("warns that deleting steps also removes their connections", () => {
    expect(deleteActionDescription({ nodes: 1, edges: 0 })).toContain("connections to it");
    expect(deleteActionDescription({ nodes: 2, edges: 3 })).toContain("connections to it");
  });
  it("does not claim an edge-only delete removes anything else", () => {
    const copy = deleteActionDescription({ nodes: 0, edges: 1 });
    expect(copy).toContain("removes the connection");
    expect(copy).not.toContain("connections to it");
  });
  it("always says the reason is recorded", () => {
    expect(deleteActionDescription({ nodes: 1, edges: 0 })).toContain("change log");
    expect(deleteActionDescription({ nodes: 0, edges: 1 })).toContain("change log");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/canvas/delete-reason.test.ts`
Expected: FAIL — cannot resolve `./delete-reason`.

- [ ] **Step 3: Write the module**

Create `src/components/canvas/delete-reason.ts`:

```ts
/**
 * Copy for the "why are you deleting this?" prompt.
 *
 * Deleting a step, connection, or lane requires a reason — the backend rejects a
 * blank one with a 422, exactly as it does for a rename or a lane move. Because
 * cancelling the prompt aborts the delete, the prompt is also the confirm step,
 * so its wording has to say what the delete takes with it.
 *
 * Pure and separate from `bpmn-canvas.tsx` so it can be tested without rendering
 * the canvas.
 */

export interface DeleteCounts {
  nodes: number;
  edges: number;
}

const RECORDED = "Add a short reason — it's saved to the change log.";

/** Title for the reason modal, e.g. "Delete 3 steps" / "Delete 5 items". */
export function deleteActionLabel({ nodes, edges }: DeleteCounts): string {
  // A mixed selection collapses to a total rather than enumerating both counts;
  // the modal is a prompt, not an inventory (that's issue #54's job).
  if (nodes > 0 && edges > 0) return `Delete ${nodes + edges} items`;
  if (edges > 0) return edges === 1 ? "Delete connection" : `Delete ${edges} connections`;
  return nodes > 1 ? `Delete ${nodes} steps` : "Delete step";
}

/** Body copy for the reason modal. Says what else the delete removes. */
export function deleteActionDescription({ nodes, edges }: DeleteCounts): string {
  if (nodes === 0 && edges > 0) {
    const subject = edges === 1 ? "the connection" : "the connections";
    return `This removes ${subject}. ${RECORDED}`;
  }
  // Any selection containing a step also takes that step's edges with it.
  return `This removes the selection and any connections to it. ${RECORDED}`;
}

export const DELETE_LANE_LABEL = "Delete lane";
export const DELETE_LANE_DESCRIPTION =
  `This removes the lane; its steps move to the first remaining lane. ${RECORDED}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/canvas/delete-reason.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/delete-reason.ts src/components/canvas/delete-reason.test.ts
git commit -m "feat(canvas): add delete-reason prompt copy module

Kept out of bpmn-canvas.tsx so the label and description logic is unit-testable
without rendering the SVG, matching selection.ts and suggestion-apply.ts.

Refs #53"
```

---

### Task 5: Frontend — destructive variant of the reason prompt

**Files:**
- Modify: `src/components/canvas/use-reason-prompt.ts`
- Modify: `src/components/canvas/reason-prompt-dialog.tsx`

No test in this task: both files are React (a hook and a modal), and this repo's canvas tests are
pure-logic only — there is no rendering harness to hang a test on, and adding one for a
two-property prop drill would be a larger change than the feature. Task 8's manual pass covers it.

- [ ] **Step 1: Extend the hook**

In `src/components/canvas/use-reason-prompt.ts`, add the options type above `ReasonPromptState`:

```ts
export interface ReasonPromptOptions {
  /** Render as a destructive action: red confirm button labelled "Delete". */
  destructive?: boolean;
  /** Replace the modal's body copy (deletes explain what else they remove). */
  description?: string;
}
```

Add two fields to `ReasonPromptState`, after `actionLabel`:

```ts
  /** True when the pending action destroys something (see ReasonPromptOptions). */
  destructive: boolean;
  /** Body copy override, or null for the dialog's default. */
  description: string | null;
```

and change the `promptReason` member's type to:

```ts
  promptReason: (
    actionLabel: string,
    options?: ReasonPromptOptions
  ) => Promise<string | null>;
```

In the hook body, add state next to `actionLabel`:

```ts
  const [destructive, setDestructive] = useState(false);
  const [description, setDescription] = useState<string | null>(null);
```

Replace `promptReason` with:

```ts
  const promptReason = useCallback(
    (label: string, options?: ReasonPromptOptions) => {
      // If a prompt is somehow already open, cancel it before opening the next.
      if (resolverRef.current) {
        const prev = resolverRef.current;
        resolverRef.current = null;
        prev(null);
      }
      setActionLabel(label);
      setDestructive(options?.destructive ?? false);
      setDescription(options?.description ?? null);
      setOpen(true);
      return new Promise<string | null>((resolve) => {
        resolverRef.current = resolve;
      });
    },
    []
  );
```

and the return:

```ts
  return { open, actionLabel, destructive, description, submit, cancel, promptReason };
```

Finally extend the module docstring — after the sentence ending "...never call this." add:

```
 * Deletes use the same prompt with `{ destructive: true }`: because cancelling
 * aborts the pending delete, the prompt doubles as the confirm step.
```

- [ ] **Step 2: Extend the dialog**

In `src/components/canvas/reason-prompt-dialog.tsx`, add the two props to the destructured
parameter list:

```tsx
export function ReasonPromptDialog({
  open,
  actionLabel,
  destructive,
  description,
  submit,
  cancel,
}: ReasonPromptState) {
```

Replace the `<DialogDescription>` block with:

```tsx
          <DialogDescription>
            {description ??
              "Add a short reason for this change. It is saved to the change log so the edit history stays explainable."}
          </DialogDescription>
```

Replace the placeholder on the `<Textarea>`:

```tsx
          placeholder={
            destructive
              ? "e.g. Duplicate of the intake step"
              : "e.g. Corrected per the SOP review"
          }
```

Replace the confirm `<Button>`:

```tsx
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => submitAndReset(value)}
            disabled={value.trim() === ""}
          >
            {destructive ? "Delete" : "Save change"}
          </Button>
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean. (`bpmn-canvas.tsx` spreads the whole hook state into the dialog, so the two new
props flow through without a change there.)

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/use-reason-prompt.ts src/components/canvas/reason-prompt-dialog.tsx
git commit -m "feat(canvas): add a destructive variant to the reason prompt

Deletes reuse the reason modal with a red Delete button and copy describing
what the delete removes. Cancel already aborts, so the prompt doubles as the
confirm — no second are-you-sure dialog.

Refs #53"
```

---

### Task 6: Frontend — delete steps carry the suggestion's reason

**Files:**
- Modify: `src/components/canvas/suggestion-apply.ts:14-28,311-329`
- Modify: `src/components/canvas/suggestion-apply.test.ts`

`withReason` currently skips delete steps because deletes "auto-log on the backend" — true while the
backend hardcoded `"Deleted"`, false as of Task 1. Without this task, every AI-applied delete would
send `undefined` and 422.

- [ ] **Step 1: Write the failing test**

Append to `src/components/canvas/suggestion-apply.test.ts`:

```ts
describe("planBundle reasons on delete steps", () => {
  const RATIONALE = "The SOP shows this path was retired.";

  /** One suggestion carrying a real rationale (the `sg` helper leaves it ""). */
  const withRationale = (
    opOverrides: Partial<SuggestionOp> & { kind: SuggestionOp["kind"] }
  ): ChatSuggestion => ({ ...sg("a", opOverrides), rationale: RATIONALE });

  const stepsFor = (opOverrides: Partial<SuggestionOp> & { kind: SuggestionOp["kind"] }) =>
    planBundle(bundleSuggestions([withRationale(opOverrides)])[0], idx()).steps;

  it("gives delete_node the owning suggestion's rationale", () => {
    expect(stepsFor({ kind: "remove_node", node_ref: "N1" })[0]).toMatchObject({
      kind: "delete_node",
      reason: RATIONALE,
    });
  });

  it("gives delete_edge, reroute_edge and delete_lane a reason too", () => {
    expect(stepsFor({ kind: "remove_edge", edge_ref: "E1" })[0]).toMatchObject({
      kind: "delete_edge",
      reason: RATIONALE,
    });
    expect(
      stepsFor({ kind: "reroute_edge", edge_ref: "E1", from_ref: "N1", to_ref: "N2" })[0]
    ).toMatchObject({ kind: "reroute_edge", reason: RATIONALE });
    expect(stepsFor({ kind: "remove_lane", lane_ref: "L1" })[0]).toMatchObject({
      kind: "delete_lane",
      reason: RATIONALE,
    });
  });

  it("falls back to a title-derived reason when there is no rationale", () => {
    // `sg` sets title = id, so this reads "Applied AI suggestion: a".
    const bundle = bundleSuggestions([sg("a", { kind: "remove_node", node_ref: "N1" })])[0];
    expect(planBundle(bundle, idx()).steps[0]).toMatchObject({
      reason: "Applied AI suggestion: a",
    });
  });
});
```

Everything this test needs is already in the file: `bundleSuggestions`, `planBundle`, and the
`op` / `sg` / `idx` helpers, plus the `SuggestionOp` and `ChatSuggestion` types. Add no imports.
Note the refs (`N1`, `N2`, `E1`, `L1`) must be ones `idx()` knows about, or `planBundle` marks the
plan unapplyable and returns no steps.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/canvas/suggestion-apply.test.ts`
Expected: FAIL — the delete steps come back without a `reason` property.

- [ ] **Step 3: Give every step kind a reason**

In `src/components/canvas/suggestion-apply.ts`, add `reason?: string` to the four delete members of
`MutationStep` (lines 19, 22, 24, 27):

```ts
  | { kind: "delete_node"; nodeRef: string; reason?: string }
  | { kind: "delete_edge"; edgeRef: string; reason?: string }
  | { kind: "reroute_edge"; edgeRef: string; fromRef: string | null; toRef: string | null; reason?: string }
  | { kind: "delete_lane"; laneRef: string; reason?: string }
```

Update the type's docstring (lines 14-16):

```ts
/* `reason` is the change-log reason the executor sends with the request. Every
 * step kind carries one: the backend requires a reason for semantic edits, for
 * creates (to attribute them to the AI rather than a manual user edit), and —
 * since #53 — for deletes, which are the most provenance-critical edit of all.
 * `planBundle` fills it from the owning suggestion's rationale. */
```

Replace `withReason` (lines 311-329) — the switch existed only to exclude the delete kinds, and
with those included it selects everything:

```ts
/** Attach the owning suggestion's reason to every step. The backend requires a
 * reason on semantic edits, on creates (so the Change Log attributes them to the
 * AI instead of defaulting to a manual user edit), and on deletes. */
function withReason(step: MutationStep, reason: string): MutationStep {
  return { ...step, reason };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/canvas/suggestion-apply.test.ts`
Expected: all pass, including the pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/suggestion-apply.ts src/components/canvas/suggestion-apply.test.ts
git commit -m "feat(canvas): carry the suggestion reason onto delete steps

withReason skipped deletes because they auto-logged on the backend. That stops
being true once deletes require a reason, so every step kind now carries one and
the exclusion switch collapses to a spread.

Refs #53"
```

---

### Task 7: Frontend — API client and every canvas call site

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts:299-302,318-321,347-351`
- Create: `src/lib/api-delete.test.ts`
- Modify: `src/components/canvas/bpmn-canvas.tsx` (call sites listed below)

This is the one large task. `api.ts` and `bpmn-canvas.tsx` must change together — TypeScript will
not compile in between — so do not commit partway.

- [ ] **Step 1: Write the failing test**

Create `src/lib/api-delete.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./api";

const PROJECT = "11111111-1111-1111-1111-111111111111";
const TARGET = "22222222-2222-2222-2222-222222222222";

function stubFetch() {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("delete requests carry the reason in a JSON body", () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    fetchMock = stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the reason when deleting a node", async () => {
    await api.deleteNode(PROJECT, TARGET, { reason: "Duplicate step" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/nodes/${TARGET}`);
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "Duplicate step" });
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("sends the reason when deleting an edge", async () => {
    await api.deleteEdge(PROJECT, TARGET, { reason: "Path retired" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ reason: "Path retired" });
  });

  it("sends the lane reason in the body, not as a query param", async () => {
    await api.deleteLane(PROJECT, TARGET, { reason: "Merged", ai_applied: true });
    const [url, init] = fetchMock.mock.calls[0];
    // The retired ?ai_applied=true query param must be gone.
    expect(url).not.toContain("ai_applied");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "Merged", ai_applied: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/api-delete.test.ts`
Expected: FAIL — the calls take no body argument, so `init.body` is undefined.

- [ ] **Step 3: Add the wire type**

In `src/lib/types.ts`, next to the other `*Update` request types:

```ts
/** Body for the node / edge / lane delete endpoints. `reason` is required —
 * the backend 422s on a blank one — even though the schema permits null so the
 * server can return a readable error rather than a validation envelope. */
export type DeleteRequest = {
  reason: string;
  ai_applied?: boolean;
};
```

- [ ] **Step 4: Update the three API functions**

Add `DeleteRequest` to the type import block at the top of `src/lib/api.ts` (alphabetically, after
`DecomposeResult`). Then:

```ts
  deleteNode: (projectId: UUID, nodeId: UUID, body: DeleteRequest) =>
    request<void>(`/api/v2/projects/${projectId}/nodes/${nodeId}`, {
      method: "DELETE",
      json: body,
    }),
```

```ts
  deleteEdge: (projectId: UUID, edgeId: UUID, body: DeleteRequest) =>
    request<void>(`/api/v2/projects/${projectId}/edges/${edgeId}`, {
      method: "DELETE",
      json: body,
    }),
```

```ts
  deleteLane: (projectId: UUID, laneId: UUID, body: DeleteRequest) =>
    request<void>(`/api/v2/projects/${projectId}/lanes/${laneId}`, {
      method: "DELETE",
      json: body,
    }),
```

Note `deleteLane`'s old third parameter (`aiApplied = false`, appended as `?ai_applied=true`) is
**removed**, not kept alongside the body.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/api-delete.test.ts`
Expected: 3 passed.

- [ ] **Step 6: Find every broken call site**

Run: `npx tsc --noEmit`
Expected: errors in `src/components/canvas/bpmn-canvas.tsx` only. Keep this list — it is the
checklist for the next step, and it is the reason `reason` was made a required parameter rather
than an optional one.

- [ ] **Step 7: Make the three impls reason-taking**

In `src/components/canvas/bpmn-canvas.tsx`, add to the imports near the other canvas-local modules:

```ts
import {
  DELETE_LANE_DESCRIPTION,
  DELETE_LANE_LABEL,
  deleteActionDescription,
  deleteActionLabel,
} from "./delete-reason";
```

`deleteNodeImpl` (`:296`) — takes the whole request body rather than a bare string, so the AI path
can reuse it instead of re-implementing the local-state cleanup:

```tsx
  const deleteNodeImpl = useCallback(
    async (id: UUID, body: DeleteRequest) => {
      await api.deleteNode(projectId, id, body);
      setNodes((curr) => curr.filter((n) => n.id !== id));
      setEdges((curr) => curr.filter((e) => e.from !== id && e.to !== id));
      deselect(id);
      onNodeDeleted?.(id);
    },
    [projectId, onNodeDeleted, deselect]
  );
```

Import the type alongside the other `@/lib/types` imports: `import type { DeleteRequest } from
"@/lib/types";` (merge into the existing type-import block rather than adding a new line).

`deleteEdgeImpl` (`:551`) — same, and its recorded redo states its own reason:

```tsx
  const deleteEdgeImpl = useCallback(
    async (id: UUID, reason: string) => {
      const edge = edgesRef.current.find((e) => e.id === id);
      if (!edge) return;
      // currentId tracks whichever UUID the edge has now — across undo/redo
      // cycles, recreating issues a NEW id, so the next delete must use it.
      let currentId = id;
      const remove = (rid: UUID) => {
        setEdges((curr) => curr.filter((e2) => e2.id !== rid));
        deselect(rid);
      };
      const recreate = async () => {
        const created = await api.createEdge(projectId, modelId, versionId, {
          source_node_id: edge.from,
          target_node_id: edge.to,
          label: edge.label,
        });
        currentId = created.id;
        setEdges((curr) => [
          ...curr,
          {
            id: currentId,
            from: edge.from,
            to: edge.to,
            label: created.label ?? null,
          },
        ]);
      };
      await api.deleteEdge(projectId, currentId, { reason });
      remove(currentId);
      const description = "Delete edge";
      record({
        description,
        do: async () => {
          await api.deleteEdge(projectId, currentId, { reason: `Redo of ${description}` });
          remove(currentId);
        },
        undo: recreate,
      });
    },
    [projectId, modelId, versionId, record, deselect]
  );
```

- [ ] **Step 8: Add the prompting wrappers**

Insert immediately after `deleteEdgeImpl`, replacing the existing `deleteSelectionImpl` (`:593`):

```tsx
  /** Prompt for a reason, then delete every selected node and edge with it.
   * One prompt covers the whole selection: one user decision, one rationale,
   * N recorded consequences. */
  const deleteSelectionImpl = useCallback(async () => {
    const ids = [...selectedIdsRef.current];
    if (ids.length === 0) return;
    const nodeIds = ids.filter((id) => nodesRef.current.some((n) => n.id === id));
    const edgeIds = ids.filter((id) => edgesRef.current.some((e) => e.id === id));
    const counts = { nodes: nodeIds.length, edges: edgeIds.length };
    const reason = await promptReason(deleteActionLabel(counts), {
      destructive: true,
      description: deleteActionDescription(counts),
    });
    if (reason === null) return;
    // Nodes first: deleteNodeImpl also strips their touching edges locally.
    for (const id of nodeIds) {
      await deleteNodeImpl(id, { reason });
    }
    // Then any still-present standalone edges (skip ones a node delete removed).
    for (const id of edgeIds) {
      if (edgesRef.current.some((e) => e.id === id)) {
        await deleteEdgeImpl(id, reason);
      }
    }
  }, [deleteNodeImpl, deleteEdgeImpl, promptReason]);

  /** Panel/handle entry point for deleting one node. */
  const requestDeleteNode = useCallback(
    async (id: UUID) => {
      const counts = { nodes: 1, edges: 0 };
      const reason = await promptReason(deleteActionLabel(counts), {
        destructive: true,
        description: deleteActionDescription(counts),
      });
      if (reason === null) return;
      await deleteNodeImpl(id, { reason });
    },
    [deleteNodeImpl, promptReason]
  );

  /** Context-menu entry point for deleting one edge. */
  const requestDeleteEdge = useCallback(
    async (id: UUID) => {
      const counts = { nodes: 0, edges: 1 };
      const reason = await promptReason(deleteActionLabel(counts), {
        destructive: true,
        description: deleteActionDescription(counts),
      });
      if (reason === null) return;
      await deleteEdgeImpl(id, reason);
    },
    [deleteEdgeImpl, promptReason]
  );
```

- [ ] **Step 9: Give the AI and undo call sites their reasons**

Work through the `tsc` list from Step 6. Every one of these is a non-prompting path.

`addProposedStep`'s undo (`:515`):

```tsx
          undo: () => deleteNodeImpl(liveNode.id, { reason: "Undo of Add AI-proposed step" }),
```

`createEdgeImpl`'s undo (`:667`):

```tsx
          await api.deleteEdge(projectId, currentId, { reason: "Undo of Create edge" });
```

Suggestion-executor `delete_node` (`:740`) — this is why `deleteNodeImpl` takes a body: the AI path
needs `ai_applied: true` on the wire but the exact same local-state cleanup:

```tsx
        case "delete_node": {
          const id = resolve(step.nodeRef);
          await deleteNodeImpl(id, {
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          // delete-containing plans aren't undoable; no inverse pushed.
          break;
        }
```

No dep-array change here — `deleteNodeImpl` is already a dependency of that `useCallback` (`:954`).

`create_node` inverse (`:775`):

```tsx
            await api.deleteNode(projectId, created.id, { reason: REVERT_REASON });
```

`create_edge` inverse (`:795`):

```tsx
            await api.deleteEdge(projectId, created.id, { reason: REVERT_REASON });
```

Suggestion-executor `delete_edge` (`:802`):

```tsx
          await api.deleteEdge(projectId, id, {
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
```

`reroute_edge`'s internal delete (`:831`):

```tsx
          await api.deleteEdge(projectId, id, {
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
```

`create_lane` inverse (`:878`):

```tsx
            await api.deleteLane(projectId, created.id, { reason: REVERT_REASON });
```

Suggestion-executor `delete_lane` (`:906`) — the positional `true` becomes the body:

```tsx
          await api.deleteLane(projectId, id, {
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
```

Paste undo (`:2092`–`:2093`):

```tsx
      for (const id of edgeIds)
        await api.deleteEdge(projectId, id, { reason: "Undo of Paste" }).catch(() => {});
      for (const id of nodeIds)
        await api.deleteNode(projectId, id, { reason: "Undo of Paste" }).catch(() => {});
```

- [ ] **Step 10: Repoint the menus, the handle, and the lane delete**

Edge context menu (`:2154`) — prompt rather than delete outright:

```tsx
          { label: "Delete", onSelect: () => void requestDeleteEdge(edgeId) },
```

and swap the dep at `:2158` from `deleteEdgeImpl` to `requestDeleteEdge`.

The imperative handle (`:1974`) — the Properties panel and the page keep calling `deleteNode(id)`
and `deleteSelection()`, now backed by the prompting wrappers:

```tsx
      deleteNode: requestDeleteNode,
```

and swap `deleteNodeImpl` for `requestDeleteNode` in that `useImperativeHandle` dep array (`:1995`).

`deleteLane` (`:2358`) — prompt first, then delete. The rest of the body is unchanged:

```tsx
  const deleteLane = useCallback(
    async (laneId: string) => {
      if (lanesRef.current.length <= 1) return;
      const reason = await promptReason(DELETE_LANE_LABEL, {
        destructive: true,
        description: DELETE_LANE_DESCRIPTION,
      });
      if (reason === null) return;
      // Flush pending PATCHes so we don't fire a 404 against a deleted lane.
      await flush();
      try {
        await api.deleteLane(projectId, laneId, { reason });
```

and add `promptReason` to that `useCallback`'s dep array (`:2394`): `[projectId, flush, promptReason]`.

- [ ] **Step 11: Verify the whole frontend**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx vitest run`
Expected: all pass.

Run: `npx next build`
Expected: succeeds.

If `tsc` still reports a `deleteNode` / `deleteEdge` / `deleteLane` call, it is a site this plan
missed — give it a reason from the §2.3 table in the spec rather than a placeholder string.

- [ ] **Step 12: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts src/lib/api-delete.test.ts \
        src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(canvas): prompt for a delete reason and thread it to the API

The three delete impls take a required reason, which turned every call site into
a compile error until it stated one — the audit that made the AI, undo, redo and
paste-undo paths explicit instead of silently writing \"Deleted\".

Manual deletes prompt once per user action (one reason covers a multi-select and
a node's cascaded edges); AI-applied deletes carry the suggestion's rationale and
never prompt.

Closes #53"
```

---

### Task 8: Verification and PR

- [ ] **Step 1: Full backend suite**

Run: `cd backend && python -m pytest`
Expected: all pass. Record the count — the branch started from a green `main`.

- [ ] **Step 2: Full frontend suite**

Run: `npx vitest run && npx tsc --noEmit && npx next build`
Expected: all three succeed.

- [ ] **Step 3: Manual verification against the running app**

Start with `./run-local.sh` (or the `run-poet-local` workflow) and walk the flows. Do not skip
this — Tasks 5 and 7 have no automated coverage of the modal or the wiring.

- [ ] Select a step → Properties panel → **Delete** → the modal is titled "Delete step", the
      confirm button is red and reads **Delete**, and it is disabled until text is entered.
- [ ] **Cancel** → the step is still on the canvas and the panel's Delete button is live again.
- [ ] Delete with a reason → the step disappears and the reason shows in the Change Log.
- [ ] Marquee-select 2 steps + 1 connection → press Delete → **one** modal titled "Delete 3 items";
      after confirming, every resulting entry in the Change Log carries that one reason.
- [ ] Delete a step that has connections → no second prompt for the edges.
- [ ] Right-click a connection → Delete → modal titled "Delete connection" → confirm → **Cmd+Z**
      restores it.
- [ ] Lane rail kebab → Delete lane → modal says the steps move to the first remaining lane →
      confirm → they do.
- [ ] Ask the chat for a change that removes something, apply the card → **no prompt**, and the
      Change Log entry shows the card's rationale attributed to the AI, not "Deleted".

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/require-reason-on-delete
gh pr create --repo ewise123/processreengineering \
  --title "Require a reason on delete (node/edge/lane)" \
  --body "$(cat <<'BODY'
Closes #53.

Deleting a step, connection, or lane now requires a reason — the same hard 422
the rename and lane-move paths already raise — and that reason lands on the
`change_event` instead of the hardcoded string `"Deleted"`.

## Backend
- Shared `DeleteRequest` body (`reason`, `ai_applied`) on all three delete endpoints.
- One `_require_delete_reason` gate, run before any mutation, so a rejected delete
  leaves no partial state and writes no phantom event.
- `ai_applied` now distinguishes an AI delete from a hand delete for nodes and edges.
- `delete_lane`'s `ai_applied` **query param** and its two canned reason strings are
  retired: an AI lane delete now logs the suggestion's actual rationale.

## Frontend
- The delete impls take a required `reason`, which forced every call site to state one.
- Manual deletes prompt via the existing reason modal, now with a destructive variant.
  Cancel aborts, so the prompt is also the confirm — no second dialog.
- One prompt per user action: a multi-select shares one reason, and a node's cascaded
  edges are covered by the node's.
- AI-applied deletes, undo-of-create, redo, and paste-undo supply reasons
  programmatically and never prompt.

## Out of scope
- Richer delete UX (impact preview, gap-marking, replacements) — #54.
- Cascaded edge deletes and lane-delete node reassignment still write no
  `change_event` — pre-existing, filed as #77.

## Verification
- `cd backend && python -m pytest` — green
- `npx vitest run` · `npx tsc --noEmit` · `npx next build` — green
- Manual pass over all six delete surfaces plus an AI-applied delete.

Spec: `docs/superpowers/specs/2026-07-28-require-reason-on-delete-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01KCfLXf4WmhhEbcHwHP6daN
BODY
)"
```

- [ ] **Step 5: Run `/autofix-pr`**

Per `CLAUDE.md`: after creating a PR on a feature branch, run `/autofix-pr` to monitor and
auto-fix review comments and CI failures.

- [ ] **Step 6: Sync the issue and the board**

Comment on #53 with the PR link and move its board card out of **In Progress**. Do not close it —
the issue closes when the PR merges, and merging to `main` needs explicit approval.

---

## Notes for the implementer

**Refinements adopted during Task 1's code review** — Tasks 2 and 3 inherit these, so don't
reintroduce the earlier shapes:

- `_require_delete_reason` returns `(reason, ai_applied)`, not just the reason. Returning both
  keeps `payload` from staying typed `DeleteRequest | None` past the gate, which is what forced the
  unreachable `payload.ai_applied if payload else False` in the first draft.
- Its docstring states the rollback rule **imperatively** ("call this before any session
  mutation — it does not roll back") rather than observing what callers happen to do. That matters
  most in `delete_lane`, where the visually obvious spot for the gate — just above
  `record_change` — sits *after* a bulk `UPDATE ProcessNode SET lane_id=...`.
- Rejection tests pin the **full** 422 string, not a substring. A substring match passes for all
  three endpoints, so a copied message would leave the suite green while telling the user the
  wrong noun.
- The parametrize lists cover `reason=""` as well as `None` and whitespace, and carry `ids=` so a
  failure names the case.
- Task 1 also added wire-level `TestClient` coverage of the new contract (optional, non-embedded
  JSON body on a `DELETE`). Reuse its `client.request("DELETE", url, json=...)` form —
  `client.delete(url, json=...)` raises `TypeError`, because `httpx` omits the body shorthand from
  `.delete()`.

**Do not weaken the gate to make a test pass.** If a backend test fails with "A reason is required",
the fix is to give that caller a reason, not to make the reason optional. The whole point of the
change is that there is no path to a delete without one.

**The delete arguments are required on purpose.** If a new call site is awkward to give a reason to,
that is the design working — decide whether it is a user action (prompt) or a system action
(programmatic reason from the §2.3 table). Do not add a default value or make the parameter
optional; that would restore exactly the silent-delete path this change removes.

**The follow-up hole is real but out of scope.** Cascaded edge deletes and lane-delete node
reassignment still write no `change_event`. That is #77. Resist fixing it here.
