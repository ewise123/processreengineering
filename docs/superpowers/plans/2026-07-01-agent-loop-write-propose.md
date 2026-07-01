# Agent Loop — Write / Propose Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent loop one `propose_changes` write tool that validates and accumulates suggested edits (surfaced as the existing approval cards, never auto-applied), unify ask + suggest into that one loop, and close 3 BPMN op-coverage gaps.

**Architecture:** Extend the shipped read-only loop (`map_chat_agent.py`) with a single coarse `propose_changes` tool (the industry-standard shape). The tool validates each op against the live map inside the loop and returns per-op accept/reject verdicts the model self-corrects from; accepted ops accumulate and become `ChatSuggestion` cards in the batch response. The proven card → Apply/Undo pipeline is reused unchanged. Suggestion build/validate/resolve logic moves into a shared `suggestion_ops.py` so both the (retiring) endpoint path and the loop use one source of truth.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy / Pydantic / Anthropic SDK (backend); Next.js / React / TypeScript / Vitest (frontend).

**Design spec:** `docs/superpowers/specs/2026-07-01-agent-loop-write-propose-design.md`

**Test commands:**
- Backend: `cd backend && source .venv/bin/activate && pytest <path> -v` (fake Anthropic client; no API key needed)
- Frontend: `npm run test` · `npx tsc --noEmit` · `npm run build`

**Conventions:** Branch `design/agent-loop-write-propose` (already created off main). Conventional commits. Never commit to main. `gh` needs `--repo ewise123/processreengineering`.

---

## File Structure

**Backend — create:**
- `backend/app/services/suggestion_ops.py` — pure suggestion build/validate/resolve/repair helpers, moved out of `process_maps.py`. Adds `build_suggestion()` (returns `(ChatSuggestion | None, error | None)`) and `validate_proposal_batch()` (returns `(accepted, rejected)`). Shared by the loop and (until retired) the endpoint.
- `backend/tests/test_suggestion_ops.py` — unit tests for the shared module.

**Backend — modify:**
- `backend/app/schemas/version_chat_suggest.py` — 3 new `OpKind`s, `SuggestionOp.condition_text`, `_REQUIRED_BY_KIND` entries.
- `backend/app/schemas/process_map.py` — `EdgeUpdate.condition_text`.
- `backend/app/api/v2/process_maps.py` — `update_edge` sets/logs `condition_text`; `delete_lane` gains `ai_applied`; import the moved helpers from `suggestion_ops`; collapse the `ChatMode` branch in `chat_suggest`; build accumulated proposals into the response.
- `backend/app/services/map_chat_agent.py` — house `PROPOSE_TOOL` + propose/mention instructions; add `propose_changes` to the loop; validate + accumulate proposals; `AgentResult` gains `proposals` + `group_summaries`.
- `backend/app/services/map_chat_suggest.py` — retire `run_chat_suggest` (Task 12).

**Backend — modify tests:** `test_map_chat_agent.py`, `test_agent_endpoint.py`, `test_chat_suggest.py`.

**Frontend — modify:**
- `src/lib/types.ts` — `OpKind` union (+3), `SuggestionOp.condition_text`, `EdgeUpdate.condition_text`.
- `src/lib/api.ts` — `deleteLane` accepts `ai_applied`.
- `src/components/canvas/suggestion-apply.ts` — `opToSteps` (+3), `MutationStep` (extend `update_node`; new `delete_lane`, `update_edge_condition`), `stepRealRefs`, `withReason`, `DELETE_OPS`.
- `src/components/canvas/bpmn-canvas.tsx` — `runStep` sends node `type`; new `delete_lane` + `update_edge_condition` cases.
- `src/components/canvas/suggestion-display.ts` — `opTarget`/`opPayload` (+3).
- `src/components/canvas/suggestion-card.tsx` — `ACTION_LABEL` (+3); per-proposal grounded chip.

**Frontend — modify tests:** `suggestion-apply.test.ts`, `suggestion-display.test.ts`.

---

## Phase A — Backend BPMN op extensions

### Task 1: `EdgeUpdate.condition_text` + `update_edge` sets/logs it

**Files:**
- Modify: `backend/app/schemas/process_map.py:98` (`EdgeUpdate`)
- Modify: `backend/app/api/v2/process_maps.py:1066-1106` (`update_edge`)
- Test: `backend/tests/test_node_lane_editing.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_node_lane_editing.py`:

```python
def test_update_edge_sets_condition_text(client, seed_version_with_edge):
    """PATCH /edges/{id} with condition_text persists the gateway branch guard
    and records an AI-attributed change when ai_applied is true."""
    edge_id = seed_version_with_edge.edge_id
    project_id = seed_version_with_edge.project_id
    resp = client.patch(
        f"/api/v2/projects/{project_id}/edges/{edge_id}",
        json={"condition_text": "amount > 10000", "reason": "gateway guard", "ai_applied": True},
    )
    assert resp.status_code == 200
    assert resp.json()["condition_text"] == "amount > 10000"
```

If `seed_version_with_edge` does not exist, reuse the edge-seeding fixture already used by the edge label tests in this file (search for an existing `def test_update_edge_label` and copy its setup; name the fixture/inline setup to match).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_node_lane_editing.py::test_update_edge_sets_condition_text -v`
Expected: FAIL — `condition_text` is not accepted / not returned (422 or KeyError).

- [ ] **Step 3: Add the schema field**

In `backend/app/schemas/process_map.py`, `EdgeUpdate` (line 98), add after `label`:

```python
    condition_text: str | None = None
```

- [ ] **Step 4: Set + log it in `update_edge`**

In `backend/app/api/v2/process_maps.py`, inside `update_edge` (after the `bend_y` block near line 1085, before the `label_changed` check):

```python
    old_condition = edge.condition_text
    if "condition_text" in payload.model_fields_set:
        edge.condition_text = payload.condition_text or None
```

Then, after the existing `if label_changed:` block (after line 1103), add:

```python
    condition_changed = (
        "condition_text" in payload.model_fields_set
        and (payload.condition_text or None) != old_condition
    )
    if condition_changed:
        if not (payload.reason and payload.reason.strip()):
            db.rollback()
            raise HTTPException(status_code=422, detail="A reason is required to change an edge condition.")
        record_change(
            db,
            target_type=ChangeTargetType.EDGE.value,
            target_id=edge.id,
            model_id=model_id_for_version(db, edge.version_id),
            version_id=edge.version_id,
            kind=ChangeKind.RELABEL.value,
            reason=payload.reason.strip(),
            before={"condition_text": old_condition},
            after={"condition_text": edge.condition_text},
            source=ChangeSource.CHAT.value if payload.ai_applied else ChangeSource.MANUAL.value,
            actor_kind=ChangeActorKind.AI.value if payload.ai_applied else ChangeActorKind.USER.value,
        )
```

Confirm `ProcessEdgeRead` (in `backend/app/schemas/process_map.py`, ~line 216) already exposes `condition_text` — it does (the model field is read there). If the response model does not serialize it, add `condition_text: str | None` to `ProcessEdgeRead`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_node_lane_editing.py::test_update_edge_sets_condition_text -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas/process_map.py backend/app/api/v2/process_maps.py backend/tests/test_node_lane_editing.py
git commit -m "feat(edges): update_edge accepts and logs condition_text"
```

---

### Task 2: `delete_lane` accepts `ai_applied` for correct AI attribution

**Files:**
- Modify: `backend/app/api/v2/process_maps.py:1575-1633` (`delete_lane`)
- Test: `backend/tests/test_node_lane_editing.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_node_lane_editing.py`:

```python
def test_delete_lane_ai_applied_attributes_to_ai(client, db_session, seed_two_lane_version):
    """DELETE /lanes/{id}?ai_applied=true records the lane deletion with
    source=CHAT / actor=AI (matches update_node's AI attribution)."""
    from app.enums import ChangeActorKind
    from app.models.change_event import ChangeEvent  # adjust import to the real change-event model

    v = seed_two_lane_version
    resp = client.delete(
        f"/api/v2/projects/{v.project_id}/lanes/{v.lane_id}?ai_applied=true"
    )
    assert resp.status_code == 204
    ev = (
        db_session.query(ChangeEvent)
        .filter(ChangeEvent.target_id == v.lane_id)
        .order_by(ChangeEvent.created_at.desc())
        .first()
    )
    assert ev.actor_kind == ChangeActorKind.AI.value
```

Reuse or add a `seed_two_lane_version` fixture (delete_lane 422s on the last lane, so the version needs ≥2 lanes). Copy the multi-lane setup from an existing lane test in this file. Adjust the `ChangeEvent` import/column names to the real change-log model (grep `record_change` to find it).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_node_lane_editing.py::test_delete_lane_ai_applied_attributes_to_ai -v`
Expected: FAIL — `delete_lane` takes no `ai_applied` and hardcodes `source=MANUAL` (no `actor_kind` set → not AI).

- [ ] **Step 3: Add the `ai_applied` query param + attribution**

In `backend/app/api/v2/process_maps.py`, change the `delete_lane` signature (line 1576) to add a query param:

```python
def delete_lane(
    project: Annotated[Project, Depends(get_project_or_404)],
    lane_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    ai_applied: bool = False,
) -> None:
```

Then in the `record_change(...)` call inside it (line 1608), replace the hardcoded `reason="Deleted"` / `source=...` with:

```python
        kind=ChangeKind.DELETE.value,
        reason="Removed by AI suggestion" if ai_applied else "Deleted",
        before={"name": lane.name},
        source=ChangeSource.CHAT.value if ai_applied else ChangeSource.MANUAL.value,
        actor_kind=ChangeActorKind.AI.value if ai_applied else ChangeActorKind.USER.value,
```

(Add `ChangeActorKind` to the imports at the top of the block if not already imported — it is used elsewhere in this file, so it is imported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_node_lane_editing.py::test_delete_lane_ai_applied_attributes_to_ai -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_node_lane_editing.py
git commit -m "feat(lanes): delete_lane accepts ai_applied for AI attribution"
```

---

### Task 3: Add the 3 new OpKinds + `condition_text` field to the suggestion schema

**Files:**
- Modify: `backend/app/schemas/version_chat_suggest.py` (`OpKind`, `SuggestionOp`, `_REQUIRED_BY_KIND`)
- Test: `backend/tests/test_chat_suggest.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_chat_suggest.py`:

```python
from app.schemas.version_chat_suggest import OpKind, SuggestionOp


def test_change_node_type_op_validates():
    op = SuggestionOp(kind=OpKind.CHANGE_NODE_TYPE, node_ref="N1", node_type="gateway_exclusive")
    assert op.kind == OpKind.CHANGE_NODE_TYPE


def test_change_node_type_requires_node_ref_and_type():
    import pytest
    with pytest.raises(ValueError):
        SuggestionOp(kind=OpKind.CHANGE_NODE_TYPE, node_ref="N1")  # missing node_type


def test_remove_lane_op_validates():
    op = SuggestionOp(kind=OpKind.REMOVE_LANE, lane_ref="L1")
    assert op.lane_ref == "L1"


def test_set_edge_condition_requires_edge_ref_and_condition():
    import pytest
    op = SuggestionOp(kind=OpKind.SET_EDGE_CONDITION, edge_ref="E1", condition_text="amount > 10000")
    assert op.condition_text == "amount > 10000"
    with pytest.raises(ValueError):
        SuggestionOp(kind=OpKind.SET_EDGE_CONDITION, edge_ref="E1")  # missing condition_text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_chat_suggest.py -k "change_node_type or remove_lane or set_edge_condition" -v`
Expected: FAIL — `AttributeError: CHANGE_NODE_TYPE` (enum members don't exist).

- [ ] **Step 3: Add the enum members, field, and required-field rules**

In `backend/app/schemas/version_chat_suggest.py`:

Add to `OpKind` (after `DECOMPOSE`, line 42):

```python
    CHANGE_NODE_TYPE = "change_node_type"
    REMOVE_LANE = "remove_lane"
    SET_EDGE_CONDITION = "set_edge_condition"
```

Add to `_REQUIRED_BY_KIND` (line 47-60), inside the dict:

```python
    OpKind.CHANGE_NODE_TYPE: ("node_ref", "node_type"),
    OpKind.REMOVE_LANE: ("lane_ref",),
    OpKind.SET_EDGE_CONDITION: ("edge_ref", "condition_text"),
```

Add the field to `SuggestionOp` (after `sub_steps`, line 84):

```python
    condition_text: str | None = Field(default=None, max_length=2000)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_chat_suggest.py -k "change_node_type or remove_lane or set_edge_condition" -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/version_chat_suggest.py backend/tests/test_chat_suggest.py
git commit -m "feat(suggest): add change_node_type, remove_lane, set_edge_condition op kinds"
```

---

## Phase B — Shared suggestion-ops module + in-loop validation

### Task 4: Extract build/validate/resolve into `suggestion_ops.py`; add error-returning build + batch validator

**Files:**
- Create: `backend/app/services/suggestion_ops.py`
- Create: `backend/tests/test_suggestion_ops.py`
- Modify: `backend/app/api/v2/process_maps.py` (import the moved helpers; delete the local copies)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_suggestion_ops.py`:

```python
from types import SimpleNamespace
from uuid import uuid4

from app.services import suggestion_ops


def _ctx():
    """A minimal MapContext stand-in exposing only the resolution maps the
    build/validate helpers read."""
    n1, l1, l2 = uuid4(), uuid4(), uuid4()
    return SimpleNamespace(
        node_ref_to_id={"N1": n1},
        edge_ref_to_id={},
        lane_ref_to_id={"L1": l1, "L2": l2},
        claim_ref_to_id={},
        node_name_by_id={n1: "Receive invoice"},
        lane_name_by_id={l1: "AP", l2: "Finance"},
        edge_label_by_id={},
    )


def test_build_suggestion_ok_returns_suggestion_and_no_error():
    raw = {"kind": "relabel_node", "node_ref": "N1", "new_label": "Log invoice", "title": "Rename", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, _ctx(), index=0)
    assert err is None
    assert sugg is not None and sugg.op.kind.value == "relabel_node"


def test_build_suggestion_bad_ref_returns_actionable_error():
    raw = {"kind": "relabel_node", "node_ref": "N9", "new_label": "x", "title": "t", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, _ctx(), index=0)
    assert sugg is None
    assert err and "N9" in err and "node" in err.lower()


def test_validate_proposal_batch_splits_accepted_and_rejected():
    ctx = _ctx()
    raw_ops = [
        {"kind": "relabel_node", "node_ref": "N1", "new_label": "ok", "title": "t", "rationale": ""},
        {"kind": "move_to_lane", "node_ref": "N9", "lane_ref": "L1", "title": "t", "rationale": ""},
    ]
    accepted, rejected = suggestion_ops.validate_proposal_batch(raw_ops, ctx, start_index=0)
    assert len(accepted) == 1 and accepted[0].op.node_ref == str(ctx.node_ref_to_id["N1"])
    assert len(rejected) == 1 and rejected[0]["index"] == 1 and "N9" in rejected[0]["error"]


def test_validate_proposal_batch_orphaned_consumer_is_rejected_not_dropped():
    """An add_edge pointing at a tmp id whose add_node was rejected must come
    back as a rejected verdict (so the model can fix it), not vanish silently."""
    ctx = _ctx()
    raw_ops = [
        # add_node missing new_label AND name -> rejected in build
        {"kind": "add_node", "temp_id": "tmp:1", "lane_ref": "L1", "node_type": "task", "title": "t", "rationale": ""},
        {"kind": "add_edge", "from_ref": "N1", "to_ref": "tmp:1", "title": "t", "rationale": ""},
    ]
    accepted, rejected = suggestion_ops.validate_proposal_batch(raw_ops, ctx, start_index=0)
    assert accepted == []
    kinds = {r["kind"] for r in rejected}
    assert kinds == {"add_node", "add_edge"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_suggestion_ops.py -v`
Expected: FAIL — `ModuleNotFoundError: app.services.suggestion_ops`.

- [ ] **Step 3: Create `suggestion_ops.py` by moving the helpers**

Create `backend/app/services/suggestion_ops.py`. Move these from `process_maps.py` **verbatim** (cut them from `process_maps.py` in Step 5): `_resolve_refs`, `_OP_REF_FIELDS`, `_resolve_one_ref`, `_MENTION_RE`, `_MENTION_KIND`, `_resolve_mention_refs`, `_build_suggestion`, `_rename_before_label`, `_repair_new_lane_temp_ids`, `_drop_orphaned_consumers`. Rename `_build_suggestion` → an internal `_build_suggestion_op` and wrap it. Add the public API:

```python
"""Pure suggestion build / validate / resolve helpers.

Moved out of the process-maps endpoint so BOTH the (retiring) single-shot suggest
path and the agent loop share one source of truth for turning a model's raw
suggestion dict into a validated ChatSuggestion — and for reporting, per op, WHY
one was rejected so the agent can self-correct in-loop.
"""
import re
from uuid import UUID, uuid4

from app.schemas.version_chat_suggest import (
    ChatSuggestion, ObjectRef, OpKind, RefKind, SuggestionOp,
)

# ---- (moved verbatim from process_maps.py) --------------------------------
# _resolve_refs, _OP_REF_FIELDS, _resolve_one_ref, _MENTION_RE, _MENTION_KIND,
# _resolve_mention_refs, _rename_before_label, _repair_new_lane_temp_ids,
# _drop_orphaned_consumers  -- paste them here unchanged.
# ---------------------------------------------------------------------------


# Human-readable object noun per ref field, for actionable rejection messages.
_REF_FIELD_NOUN = {
    "node_ref": "node", "near_node_ref": "node", "from_ref": "node", "to_ref": "node",
    "edge_ref": "edge", "lane_ref": "lane",
}


def build_suggestion(raw: dict, ctx, index: int) -> tuple[ChatSuggestion | None, str | None]:
    """Resolve one raw model op into a validated ChatSuggestion.

    Returns (suggestion, None) on success, or (None, error) with an ACTIONABLE
    message naming the offending field/ref so the agent can fix it and re-propose.
    Replaces the old silent-drop behavior for in-loop use."""
    kind = raw.get("kind")

    # Referential check FIRST so the error can name the bad ref (a resolved-but-
    # absent real ref stays a short/tmp string; only real short refs must resolve).
    for field, (map_attr, _rk) in _OP_REF_FIELDS.items():
        if field == "temp_id" or field not in raw or raw[field] is None:
            continue
        val = str(raw[field]).strip()
        if val.startswith("tmp:"):
            continue  # produced within the batch; checked by the orphan pass
        if getattr(ctx, map_attr).get(val.upper()) is None:
            noun = _REF_FIELD_NOUN.get(field, "object")
            return None, (
                f"{kind}: {field} '{raw[field]}' is not a {noun} on the current map. "
                f"Use find_node/search_claims to get a valid ref, then re-propose."
            )

    sugg = _build_suggestion_op(raw, ctx, index)  # the moved former _build_suggestion
    if sugg is None:
        # Structural failure (missing required field, bad node_type, etc.).
        try:
            SuggestionOp(**{k: raw.get(k) for k in raw if k != "title"})
        except Exception as exc:  # surface the pydantic message, trimmed
            return None, f"{kind}: {str(exc).splitlines()[-1][:160]}"
        return None, f"{kind}: malformed op."
    return sugg, None


def validate_proposal_batch(raw_ops, ctx, *, start_index: int) -> tuple[list[ChatSuggestion], list[dict]]:
    """Validate one propose_changes call's ops against the live map.

    Returns (accepted, rejected). `rejected` is a list of
    {index, kind, error} the loop feeds back to the model. Temp ids produced
    WITHIN this batch are satisfiable; a consumer whose producer was rejected is
    itself reported as rejected (never silently dropped)."""
    if not isinstance(raw_ops, list):
        return [], []
    _repair_new_lane_temp_ids(raw_ops)
    accepted: list[ChatSuggestion] = []
    rejected: list[dict] = []
    accepted_raw_by_id: dict[str, dict] = {}
    for i, raw in enumerate(raw_ops):
        idx = start_index + i
        if not isinstance(raw, dict):
            rejected.append({"index": idx, "kind": None, "error": "op is not an object"})
            continue
        sugg, err = build_suggestion(raw, ctx, idx)
        if sugg is None:
            rejected.append({"index": idx, "kind": raw.get("kind"), "error": err})
        else:
            accepted.append(sugg)
            accepted_raw_by_id[sugg.id] = raw

    # Orphan pass: prune consumers whose tmp producer is not among the accepted,
    # and report each as rejected so the model learns why.
    survivors = _drop_orphaned_consumers(accepted)
    survivor_ids = {s.id for s in survivors}
    for s in accepted:
        if s.id not in survivor_ids:
            rejected.append({
                "index": None, "kind": s.op.kind.value,
                "error": (
                    f"{s.op.kind.value}: references a new (tmp:) object whose "
                    "producing add_node/add_lane was rejected — fix the producer "
                    "and re-propose both together."
                ),
            })
    return survivors, rejected
```

Note: keep `uuid4` import (used by the moved `_build_suggestion_op`). The moved `_resolve_mention_refs`/`_rename_before_label` reference `ctx` attributes only.

- [ ] **Step 4: Run the new module's tests**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_suggestion_ops.py -v`
Expected: PASS

- [ ] **Step 5: Repoint `process_maps.py` at the moved helpers**

In `backend/app/api/v2/process_maps.py`, delete the now-moved function definitions and add an import near the other service imports:

```python
from app.services.suggestion_ops import (
    build_suggestion as _build_suggestion_with_error,
    _build_suggestion_op as _build_suggestion,
    _drop_orphaned_consumers,
    _repair_new_lane_temp_ids,
    _resolve_mention_refs,
    _resolve_refs,
    validate_proposal_batch,
)
```

Keep every existing call site working: the endpoint still calls `_build_suggestion`, `_repair_new_lane_temp_ids`, `_drop_orphaned_consumers`, `_resolve_mention_refs`, `_resolve_refs` by the same names (now imported). `_resolve_refs_scoped` and `_resolve_node_ref` stay in `process_maps.py` (only the AI-edit path uses them). `_resolve_one_ref`/`_OP_REF_FIELDS`/mention regexes move with the functions that use them.

- [ ] **Step 6: Run the full backend suite to prove no behavior change**

Run: `cd backend && source .venv/bin/activate && pytest -q`
Expected: PASS (all prior suggest/endpoint tests still green — the extraction is behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/suggestion_ops.py backend/tests/test_suggestion_ops.py backend/app/api/v2/process_maps.py
git commit -m "refactor(suggest): extract suggestion build/validate into suggestion_ops with error-returning API"
```

---

### Task 5: Pass `condition_text` through the build; confirm the 3 new kinds resolve

**Files:**
- Modify: `backend/app/services/suggestion_ops.py` (`_build_suggestion_op` literal passthrough)
- Test: `backend/tests/test_suggestion_ops.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_suggestion_ops.py`:

```python
def test_set_edge_condition_builds_with_condition_text():
    ctx = _ctx()
    ctx.edge_ref_to_id = {"E1": uuid4()}
    raw = {"kind": "set_edge_condition", "edge_ref": "E1", "condition_text": "amount > 10000", "title": "t", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, ctx, index=0)
    assert err is None
    assert sugg.op.condition_text == "amount > 10000"


def test_change_node_type_builds_with_node_type():
    raw = {"kind": "change_node_type", "node_ref": "N1", "node_type": "gateway_exclusive", "title": "t", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, _ctx(), index=0)
    assert err is None
    assert sugg.op.node_type == "gateway_exclusive"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_suggestion_ops.py -k "condition or change_node_type" -v`
Expected: FAIL — `set_edge_condition` builds but `condition_text` is dropped (not in the literal passthrough list).

- [ ] **Step 3: Add `condition_text` to the literal passthrough**

In the moved `_build_suggestion_op` (in `suggestion_ops.py`), extend the literal-fields loop (formerly line 1847) to include `condition_text`:

```python
    for field in ("new_label", "description", "name", "node_type", "edge_label", "sub_steps", "condition_text"):
        if raw.get(field) is not None:
            op_kwargs[field] = raw[field]
```

(`node_type` is already in the list, so `change_node_type` already passes through — its test proves it end-to-end.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_suggestion_ops.py -k "condition or change_node_type" -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/suggestion_ops.py backend/tests/test_suggestion_ops.py
git commit -m "feat(suggest): pass condition_text through suggestion build"
```

---

## Phase C — The propose tool in the loop

### Task 6: Move `PROPOSE_TOOL` + instructions into the agent module; add `propose_changes` to the loop

**Files:**
- Modify: `backend/app/services/map_chat_agent.py`
- Test: `backend/tests/test_map_chat_agent.py`

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_map_chat_agent.py` (reuse the `_Text`, `_ToolUse`, `_resp`, `_FakeClient` helpers already at the top of the file):

```python
def _run_with_ctx(fake, ctx, **over):
    """Like _run but with a real-ish tool_ctx + validator so propose_changes
    can validate against a map. Patches validate_proposal_batch to the ctx."""
    from app.services import suggestion_ops

    kwargs = dict(
        skeleton_text="NODES:\n  N1 [task]: Receive Invoice",
        focus_items=[], history=[], user_message="add a step",
    )
    kwargs.update(over)

    def fake_dispatch(tool_ctx, *, name, args):
        return ({"ok": True}, f"ran {name}", set())

    with patch.object(map_chat_agent, "_get_client", return_value=fake), \
         patch.object(map_chat_agent, "dispatch_tool", fake_dispatch), \
         patch.object(map_chat_agent, "validate_proposal_batch",
                      lambda ops, c, *, start_index: suggestion_ops.validate_proposal_batch(ops, ctx, start_index=start_index)):
        return map_chat_agent.run_chat_agent(tool_ctx=SimpleNamespace(mapctx=ctx), **kwargs)


def _ctx_for_agent():
    from uuid import uuid4
    n1 = uuid4()
    return SimpleNamespace(
        node_ref_to_id={"N1": n1}, edge_ref_to_id={}, lane_ref_to_id={},
        claim_ref_to_id={}, node_name_by_id={n1: "Receive"}, lane_name_by_id={}, edge_label_by_id={},
    )


def test_propose_changes_accumulates_accepted_proposals():
    ctx = _ctx_for_agent()
    fake = _FakeClient([
        _resp([_ToolUse("t1", "propose_changes", {
            "suggestions": [{"kind": "relabel_node", "node_ref": "N1", "new_label": "Log invoice", "title": "Rename", "rationale": ""}],
        })]),
        _resp([_Text("Proposed the rename.")]),
    ])
    result = _run_with_ctx(fake, ctx)
    assert result.stop_reason == "normal"
    assert len(result.proposals) == 1
    assert result.proposals[0].op.kind.value == "relabel_node"


def test_propose_rejected_op_is_returned_to_model_for_self_correction():
    ctx = _ctx_for_agent()
    fake = _FakeClient([
        _resp([_ToolUse("t1", "propose_changes", {
            "suggestions": [{"kind": "relabel_node", "node_ref": "N9", "new_label": "x", "title": "t", "rationale": ""}],
        })]),
        # After seeing the rejection the model re-proposes with the right ref.
        _resp([_ToolUse("t2", "propose_changes", {
            "suggestions": [{"kind": "relabel_node", "node_ref": "N1", "new_label": "x", "title": "t", "rationale": ""}],
        })]),
        _resp([_Text("Fixed and proposed.")]),
    ])
    result = _run_with_ctx(fake, ctx)
    # The tool_result for round 1 must carry the rejection so the model can fix it.
    round1_result = fake.calls[1]["messages"][-1]["content"][0]["content"]
    assert "N9" in round1_result and "reject" in round1_result.lower()
    assert len(result.proposals) == 1
    assert result.proposals[0].op.node_ref == str(ctx.node_ref_to_id["N1"])


def test_ops_per_run_cap_truncates_and_notes():
    ctx = _ctx_for_agent()
    # One propose call with more ops than the cap.
    many = [{"kind": "describe_node", "node_ref": "N1", "description": f"d{i}", "title": "t", "rationale": ""}
            for i in range(map_chat_agent.MAX_PROPOSED_OPS + 5)]
    fake = _FakeClient([
        _resp([_ToolUse("t1", "propose_changes", {"suggestions": many})]),
        _resp([_Text("done")]),
    ])
    result = _run_with_ctx(fake, ctx)
    assert len(result.proposals) == map_chat_agent.MAX_PROPOSED_OPS
    assert any("cap" in t["summary"].lower() or "truncat" in t["summary"].lower() for t in result.trace)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_map_chat_agent.py -k "propose or ops_per_run" -v`
Expected: FAIL — `propose_changes` unhandled; `AgentResult` has no `proposals`; `MAX_PROPOSED_OPS`/`validate_proposal_batch` not defined in module.

- [ ] **Step 3: Add the tool schema, instructions, and imports**

In `backend/app/services/map_chat_agent.py`:

Add imports near the top (with the other service imports):

```python
from app.services.suggestion_ops import validate_proposal_batch
```

Move `PROPOSE_TOOL`, `SUGGEST_INSTRUCTIONS`, and `MENTION_INSTRUCTIONS` **from `map_chat_suggest.py` into this module** (paste the constants verbatim; the agent already imports `MENTION_INSTRUCTIONS` from `map_chat_suggest` — change that import to the local definition). Update `PROPOSE_TOOL`'s description to mention the loop can call it more than once. Ensure `PROPOSE_TOOL`'s `_OP_KINDS`/`_NODE_TYPES` are computed from the enums (copy the two module-level lines that build them).

Add the write-scope cap constant near the other caps:

```python
MAX_PROPOSED_OPS = 25  # write-scope guardrail: max accepted proposals per run
```

- [ ] **Step 4: Extend `AgentResult` and the tool list**

Extend the `AgentResult` dataclass:

```python
    proposals: list = field(default_factory=list)       # accepted ChatSuggestions
    group_summaries: list = field(default_factory=list)  # raw {id, summary} dicts
```

In `run_chat_agent`, build the tool list with the write tool appended:

```python
    tools = READ_TOOLS + [PROPOSE_TOOL]
```

and pass `tools=tools` to both `client.messages.create` calls in the loop (the graceful-synthesis turn still passes NO tools).

- [ ] **Step 5: Handle `propose_changes` in the tool-dispatch loop**

In `run_chat_agent`, initialize accumulators before the round loop:

```python
    proposals: list = []
    raw_groups: list = []
```

Inside the `for tu in tool_uses:` loop, special-case the write tool BEFORE the generic `dispatch_tool` call:

```python
        for tu in tool_uses:
            if tu.name == "propose_changes":
                res, summary = _handle_propose(tu.input or {}, tool_ctx.mapctx, proposals, raw_groups)
                trace.append({"tool": "propose_changes", "summary": summary,
                              "detail": json.dumps({"args": dict(tu.input or {}), "result": res})[:4000]})
                tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": json.dumps(res)})
                continue
            res, summary, claim_ids = dispatch_tool(tool_ctx, name=tu.name, args=dict(tu.input or {}))
            consulted |= claim_ids
            trace.append({...})  # unchanged
            tool_results.append({...})  # unchanged
```

Add the handler function to the module:

```python
def _handle_propose(inp: dict, mapctx, proposals: list, raw_groups: list) -> tuple[dict, str]:
    """Validate one propose_changes call against the live map, accumulate accepted
    proposals (honoring MAX_PROPOSED_OPS), and return the per-op verdict the model
    sees + a human summary line for the trace."""
    raw_ops = inp.get("suggestions") if isinstance(inp.get("suggestions"), list) else []
    groups = inp.get("groups") if isinstance(inp.get("groups"), list) else []
    accepted, rejected = validate_proposal_batch(raw_ops, mapctx, start_index=len(proposals))

    remaining = MAX_PROPOSED_OPS - len(proposals)
    truncated = 0
    if remaining <= 0:
        truncated = len(accepted)
        accepted = []
    elif len(accepted) > remaining:
        truncated = len(accepted) - remaining
        accepted = accepted[:remaining]

    proposals.extend(accepted)
    raw_groups.extend(g for g in groups if isinstance(g, dict))

    result = {
        "accepted": [{"index": None, "kind": s.op.kind.value, "title": s.title} for s in accepted],
        "rejected": rejected,
    }
    if truncated:
        result["note"] = f"{truncated} op(s) exceeded the {MAX_PROPOSED_OPS}-change cap for this turn and were not added."
    parts = [f"Proposed {len(accepted)} change(s)"]
    if rejected:
        parts.append(f"{len(rejected)} rejected")
    if truncated:
        parts.append(f"{truncated} over cap")
    return result, "; ".join(parts)
```

After the round loop (before `return result`), assign the accumulators:

```python
    result.proposals = proposals
    result.group_summaries = raw_groups
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_map_chat_agent.py -v`
Expected: PASS (new propose tests + all prior loop tests still green).

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/map_chat_agent.py backend/tests/test_map_chat_agent.py
git commit -m "feat(agent): add propose_changes write tool with in-loop validation + self-correction"
```

---

### Task 7: Collapse the endpoint `ChatMode` branch; build accumulated proposals into the response

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (`_run_ask_agent` → the unified path; `chat_suggest`)
- Test: `backend/tests/test_agent_endpoint.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_agent_endpoint.py` (follow the file's existing fake-client + seeded-map pattern; a script that calls `propose_changes` then answers):

```python
def test_chat_endpoint_command_returns_suggestion_cards(client, seed_ap_map, fake_agent_client):
    """A change command now routes through the loop and returns applyable cards
    (no more ChatMode branch)."""
    fake_agent_client.script([
        ("propose_changes", {"suggestions": [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Log invoice", "title": "Rename", "rationale": ""}
        ]}),
        ("text", "Proposed the rename."),
    ])
    v = seed_ap_map
    resp = client.post(
        f"/api/v2/projects/{v.project_id}/process-maps/{v.model_id}/versions/{v.version_id}/chat-suggest",
        json={"user_message": "rename N1 to Log invoice", "history": [], "context_refs": []},
    )
    body = resp.json()
    assert resp.status_code == 200
    assert len(body["suggestions"]) == 1
    assert body["suggestions"][0]["op"]["kind"] == "relabel_node"
    assert body["run_id"]  # an AgentRun was persisted


def test_chat_endpoint_question_returns_prose_no_cards(client, seed_ap_map, fake_agent_client):
    fake_agent_client.script([("text", "Invoices are approved by AP. [[C1]]")])
    v = seed_ap_map
    resp = client.post(
        f"/api/v2/projects/{v.project_id}/process-maps/{v.model_id}/versions/{v.version_id}/chat-suggest",
        json={"user_message": "how are invoices approved?", "history": [], "context_refs": []},
    )
    body = resp.json()
    assert body["suggestions"] == []
    assert "approved by AP" in body["message"]
```

Adapt `fake_agent_client`/`seed_ap_map` to the fixtures already in `test_agent_endpoint.py` (it already fakes the loop client and seeds a map for the read-only tests — extend that fake to emit `tool_use` blocks for `propose_changes`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_agent_endpoint.py -k "command_returns or question_returns" -v`
Expected: FAIL — `suggest` requests still route to the single-shot path; a command via the default (now no) mode returns no cards from the loop.

- [ ] **Step 3: Build proposals into the response inside the unified path**

In `backend/app/api/v2/process_maps.py`, rename `_run_ask_agent` → `_run_chat_agent` and extend its tail (after `result = run_chat_agent(...)`) to turn accumulated proposals into cards + group summaries. Replace the `suggestions=[]` in the returned `ChatSuggestResponse` with the built list:

```python
    resolved = _resolve_mention_refs(result.answer, ctx)
    suggestions = result.proposals  # already validated ChatSuggestions with resolved refs
    # Drop top-level prose when cards are present (matches the retired suggest path).
    message = "" if suggestions else resolved
    claim_texts = [resolved] + [s.title for s in suggestions] + [s.rationale for s in suggestions]
    mention_sources = _mention_sources_from_texts(claim_texts, ctx)
    cited = [str(s.claim_id) for s in mention_sources]
    grounded = assess_grounded(resolved, cited)

    # Group summaries: only for groups actually present on an emitted suggestion
    # (reuse the exact filter from the old suggest branch).
    used_groups = {s.group for s in suggestions if s.group}
    group_summaries: list[GroupSummary] = []
    seen_groups: set[str] = set()
    for g in result.group_summaries:
        gid = str(g.get("id") or "").strip()
        summary = str(g.get("summary") or "").strip()
        if not gid or not summary or gid not in used_groups or gid in seen_groups:
            continue
        seen_groups.add(gid)
        try:
            group_summaries.append(GroupSummary(id=gid, summary=summary[:500]))
        except ValueError:
            continue

    run = _persist(answer=resolved, trace=result.trace, ...)  # unchanged persist call
    return ChatSuggestResponse(
        message=message, suggestions=suggestions, mention_sources=mention_sources,
        group_summaries=group_summaries,
        activity_trace=[ActivityStep(**t) for t in result.trace],
        run_id=run.id, grounded=grounded,
    )
```

- [ ] **Step 4: Collapse the `chat_suggest` mode branch**

In `chat_suggest`, delete the `if payload.mode == ChatMode.ASK: return _run_ask_agent(...)` special-case AND the entire `else` suggest block (the `run_chat_suggest` call and the `_repair_new_lane_temp_ids`/`_build_suggestion`/`_drop_orphaned_consumers` post-processing). Replace the whole body after context assembly with a single unconditional call:

```python
    return _run_chat_agent(db, project, model_id, version, ctx, focus_refs, payload)
```

Keep `payload.mode` on the request schema (backward compat) but ignore it. Remove the now-unused `run_chat_suggest` import (its deletion is Task 12).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && source .venv/bin/activate && pytest tests/test_agent_endpoint.py -v`
Expected: PASS

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && source .venv/bin/activate && pytest -q`
Expected: PASS. Any `test_chat_suggest.py` test asserting the OLD single-shot suggest response shape must be updated to the loop path or moved to `test_agent_endpoint.py` — do that now (the suggest path is retired).

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_agent_endpoint.py backend/tests/test_chat_suggest.py
git commit -m "feat(chat): unify ask+suggest into the agent loop; proposals return as cards"
```

---

## Phase D — Frontend op plumbing for the 3 new kinds

### Task 8: Extend frontend types (`OpKind`, `SuggestionOp.condition_text`, `EdgeUpdate.condition_text`)

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add the union members and fields**

In `src/lib/types.ts`, `OpKind` (line 378):

```typescript
export type OpKind =
  | "relabel_node" | "describe_node" | "add_node" | "remove_node"
  | "add_edge" | "remove_edge" | "relabel_edge" | "reroute_edge"
  | "move_to_lane" | "add_lane" | "rename_lane" | "decompose"
  | "change_node_type" | "remove_lane" | "set_edge_condition";
```

In `SuggestionOp` (after `sub_steps`, line 404):

```typescript
  condition_text?: string | null;
```

In `EdgeUpdate` (after `label`, line 247):

```typescript
  condition_text?: string | null;
```

- [ ] **Step 2: Verify the compiler flags the exhaustive switches**

Run: `npx tsc --noEmit`
Expected: FAIL — `opToSteps` and `stepRealRefs`'s `_exhaustive: never` no longer hold, and `ACTION_LABEL: Record<OpKind, string>` is missing keys. These are the exact sites the next tasks fix; the errors confirm every site is covered.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add change_node_type/remove_lane/set_edge_condition + condition_text"
```

---

### Task 9: `opToSteps`, `MutationStep`s, `stepRealRefs`, `withReason`, `DELETE_OPS`

**Files:**
- Modify: `src/components/canvas/suggestion-apply.ts`
- Test: `src/components/canvas/suggestion-apply.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/components/canvas/suggestion-apply.test.ts` (match the file's existing `opToSteps`/`isDeleteOp` test style):

```typescript
import { describe, it, expect } from "vitest";
import { opToSteps, isDeleteOp } from "./suggestion-apply";

describe("new op kinds → steps", () => {
  it("change_node_type → update_node with nodeType", () => {
    const steps = opToSteps({ kind: "change_node_type", node_ref: "N1", node_type: "gateway_exclusive" });
    expect(steps).toEqual([{ kind: "update_node", nodeRef: "N1", nodeType: "gateway_exclusive" }]);
  });

  it("remove_lane → delete_lane", () => {
    expect(opToSteps({ kind: "remove_lane", lane_ref: "L1" })).toEqual([{ kind: "delete_lane", laneRef: "L1" }]);
  });

  it("set_edge_condition → update_edge_condition", () => {
    const steps = opToSteps({ kind: "set_edge_condition", edge_ref: "E1", condition_text: "amt > 10000" });
    expect(steps).toEqual([{ kind: "update_edge_condition", edgeRef: "E1", conditionText: "amt > 10000" }]);
  });

  it("remove_lane is a delete op (non-undoable / confirm-gated)", () => {
    expect(isDeleteOp("remove_lane")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- suggestion-apply`
Expected: FAIL — the new op kinds fall through / are not handled.

- [ ] **Step 3: Extend the `MutationStep` union**

In `src/components/canvas/suggestion-apply.ts`, extend `MutationStep` (line 17): add `nodeType?: string` to the `update_node` member and add two new members:

```typescript
  | { kind: "update_node"; nodeRef: string; name?: string; description?: string; laneRef?: string; nodeType?: string; reason?: string }
  ...
  | { kind: "delete_lane"; laneRef: string }
  | { kind: "update_edge_condition"; edgeRef: string; conditionText: string; reason?: string };
```

- [ ] **Step 4: Add the `opToSteps` cases**

In `opToSteps` (line 29 switch), add before the `default`:

```typescript
    case "change_node_type":
      return [{ kind: "update_node", nodeRef: op.node_ref!, nodeType: op.node_type! }];
    case "remove_lane":
      return [{ kind: "delete_lane", laneRef: op.lane_ref! }];
    case "set_edge_condition":
      return [{ kind: "update_edge_condition", edgeRef: op.edge_ref!, conditionText: op.condition_text! }];
```

- [ ] **Step 5: Register the delete op, stale-ref sets, and reason attachment**

`DELETE_OPS` (line 6):

```typescript
const DELETE_OPS = new Set<OpKind>(["remove_node", "remove_edge", "reroute_edge", "remove_lane"]);
```

`stepRealRefs` (line 185 switch), add cases:

```typescript
    case "delete_lane":
      return [{ ref: step.laneRef, set: "lane" }];
    case "update_edge_condition":
      return [{ ref: step.edgeRef, set: "edge" }];
```

`withReason` (line 301 switch), add `update_edge_condition` to the semantic-edit group:

```typescript
    case "update_node":
    case "update_edge_label":
    case "update_edge_condition":
    case "update_lane":
      return { ...step, reason };
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run test -- suggestion-apply && npx tsc --noEmit`
Expected: PASS and no type errors from `suggestion-apply.ts` (the executor in `bpmn-canvas.tsx` still errors on the new step kinds — fixed in Task 10).

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas/suggestion-apply.ts src/components/canvas/suggestion-apply.test.ts
git commit -m "feat(apply): map 3 new op kinds to mutation steps; remove_lane is a delete op"
```

---

### Task 10: Executor `runStep` — send node `type`; handle `delete_lane` + `update_edge_condition`

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx` (`runStep`, ~line 686-886)
- Modify: `src/lib/api.ts` (`deleteLane` accepts `ai_applied`)

- [ ] **Step 1: `deleteLane` accepts `ai_applied`**

In `src/lib/api.ts`, change `deleteLane` (line 347) to send the flag:

```typescript
  deleteLane: (projectId: UUID, laneId: UUID, aiApplied = false) =>
    request(`/projects/${projectId}/lanes/${laneId}${aiApplied ? "?ai_applied=true" : ""}`, { method: "DELETE" }),
```

Update the existing `create_lane` inverse in `bpmn-canvas.tsx` (line 863) which calls `api.deleteLane(projectId, created.id)` — leave it as-is (undo of an AI-created lane is a user action; `false` is correct).

- [ ] **Step 2: Send `type` in the `update_node` executor**

In `bpmn-canvas.tsx`, inside `case "update_node":` (after the `description` block, ~line 700), add:

```typescript
          if (step.nodeType !== undefined) {
            apiPatch.type = step.nodeType;
            localPatch.type = step.nodeType;
            localPatch.kind = nodeKindFromType(step.nodeType);
          }
```

and in the inverse (after the `description` inverse line ~722):

```typescript
            if (step.nodeType !== undefined) inversePatch.type = before.type;
```

Capture `type` in the `prev` snapshot (line 708) so the inverse can restore it:

```typescript
          const prev = { label: before.label, description: before.description, laneId: before.laneId, type: before.type, kind: before.kind };
```

and include `type`/`kind` restoration in the optimistic inverse `setNodes` (line 714) — it already spreads `...prev`, so adding `type`/`kind` to `prev` restores them locally.

- [ ] **Step 3: Add the `delete_lane` and `update_edge_condition` cases**

In `runStep`'s switch, after the `update_lane` case (line 885), add:

```typescript
        case "delete_lane": {
          const id = resolve(step.laneRef);
          await api.deleteLane(projectId, id, true);
          setLanes((curr) => recomputeY(curr.filter((l) => l.id !== id)));
          // Backend reassigns this lane's nodes to a remaining lane; drop the
          // client-side laneId so they don't dangle. Refetch is triggered by the
          // caller; locally, clear the stale laneId.
          setNodes((curr) => curr.map((n) => (n.laneId === id ? { ...n, laneId: null } : n)));
          // delete-containing plan: no inverse.
          break;
        }
        case "update_edge_condition": {
          const id = resolve(step.edgeRef);
          const before = edgesRef.current.find((e) => e.id === id);
          if (!before) throw new Error("Edge no longer exists.");
          const oldCondition = before.condition ?? null;
          setEdges((curr) => curr.map((e) => (e.id === id ? { ...e, condition: step.conditionText } : e)));
          inverses.push(async () => {
            setEdges((curr) => curr.map((e) => (e.id === id ? { ...e, condition: oldCondition } : e)));
            await api.updateEdge(projectId, id, { condition_text: oldCondition, reason: REVERT_REASON });
          });
          await api.updateEdge(projectId, id, {
            condition_text: step.conditionText,
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          break;
        }
```

If `CanvasEdge` has no `condition` field (grep the type), either add `condition?: string | null` to it, or drop the two `condition` local-state lines and keep only the API call (the map refetches after apply). Prefer adding the field for optimistic display; if that widens scope, the API-only version is acceptable and still correct. Likewise confirm `CanvasNode.type`/`kind` exist (they do — used in `create_node`).

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS — no exhaustiveness errors remain in the executor.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx src/lib/api.ts
git commit -m "feat(canvas): execute change_node_type, remove_lane, set_edge_condition"
```

---

### Task 11: Card display — `ACTION_LABEL`, `opTarget`, `opPayload` for the 3 new kinds

**Files:**
- Modify: `src/components/canvas/suggestion-display.ts`
- Modify: `src/components/canvas/suggestion-card.tsx` (`ACTION_LABEL`)
- Test: `src/components/canvas/suggestion-display.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/components/canvas/suggestion-display.test.ts`:

```typescript
import { opTarget, opPayload } from "./suggestion-display";

describe("new op kinds → display", () => {
  it("change_node_type targets the node", () => {
    expect(opTarget({ kind: "change_node_type", node_ref: "N1", node_type: "gateway_exclusive" }))
      .toBe("[[node:N1]]");
  });
  it("change_node_type previews the new type", () => {
    expect(opPayload({ kind: "change_node_type", node_ref: "N1", node_type: "gateway_exclusive" }))
      .toEqual({ value: "gateway_exclusive", hasMention: false });
  });
  it("remove_lane targets the lane", () => {
    expect(opTarget({ kind: "remove_lane", lane_ref: "L1" })).toBe("[[lane:L1]]");
  });
  it("set_edge_condition targets the edge and previews the condition", () => {
    expect(opTarget({ kind: "set_edge_condition", edge_ref: "E1", condition_text: "amt > 10000" }))
      .toBe("[[edge:E1]]");
    expect(opPayload({ kind: "set_edge_condition", edge_ref: "E1", condition_text: "amt > 10000" }))
      .toEqual({ value: "amt > 10000", hasMention: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- suggestion-display`
Expected: FAIL — the new kinds hit the `default` (return `null`).

- [ ] **Step 3: Add `opTarget` cases**

In `src/components/canvas/suggestion-display.ts`, `opTarget` switch (line 28), add:

```typescript
    case "change_node_type":
      return nodeMention(op.node_ref);
    case "remove_lane":
      return laneMention(op.lane_ref);
    case "set_edge_condition":
      return edgeMention(op.edge_ref);
```

- [ ] **Step 4: Add `opPayload` cases**

In `opPayload` switch (line 76), add:

```typescript
    case "change_node_type":
      return op.node_type ? { value: op.node_type, hasMention: false } : null;
    case "set_edge_condition":
      return op.condition_text ? { value: op.condition_text, hasMention: false } : null;
```

(`remove_lane` has no payload preview — its `default: null` is correct; the target + verb say it all.)

- [ ] **Step 5: Add the `ACTION_LABEL` verbs**

In `src/components/canvas/suggestion-card.tsx`, `ACTION_LABEL` (line 13), add:

```typescript
  change_node_type: "Change type",
  remove_lane: "Remove lane",
  set_edge_condition: "Set condition",
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run test -- suggestion-display && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas/suggestion-display.ts src/components/canvas/suggestion-card.tsx src/components/canvas/suggestion-display.test.ts
git commit -m "feat(cards): display verbs/targets/previews for 3 new op kinds"
```

---

## Phase E — Grounding chip on the card

### Task 12: Per-proposal "not grounded in your sources" chip

**Files:**
- Modify: `src/components/canvas/suggestion-card.tsx`
- Test: `src/components/canvas/suggestion-display.test.ts` (add a pure helper + test)

- [ ] **Step 1: Write the failing test for the helper**

Add to `src/components/canvas/suggestion-display.test.ts`:

```typescript
import { isProposalGrounded } from "./suggestion-display";

describe("proposal grounding", () => {
  it("grounded when the suggestion cites at least one claim", () => {
    expect(isProposalGrounded({ cited_claim_ids: ["11111111-1111-1111-1111-111111111111"] } as never)).toBe(true);
  });
  it("not grounded when no claims are cited", () => {
    expect(isProposalGrounded({ cited_claim_ids: [] } as never)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- suggestion-display`
Expected: FAIL — `isProposalGrounded` is not exported.

- [ ] **Step 3: Add the pure helper**

In `src/components/canvas/suggestion-display.ts`, add:

```typescript
import type { ChatSuggestion } from "@/lib/types";  // extend the existing import

/** A proposed change is "grounded" when it cites at least one source claim.
 * Ungrounded proposals (general process knowledge, not from the user's sources)
 * get a distinct chip on the card — labeled, never hidden. */
export function isProposalGrounded(s: Pick<ChatSuggestion, "cited_claim_ids">): boolean {
  return (s.cited_claim_ids?.length ?? 0) > 0;
}
```

- [ ] **Step 4: Render the chip on the card**

In `src/components/canvas/suggestion-card.tsx`, import the helper and render a chip on any per-change row where `!isProposalGrounded(s)`. In the per-suggestion block (near line 189, where `transition`/`rationale` render), add:

```tsx
          {!isProposalGrounded(s) && (
            <span
              className="ml-1 inline-flex items-center rounded-sm bg-amber-50 px-1 py-px text-[9px] font-medium text-amber-700 ring-1 ring-amber-200"
              title="This change draws on general process knowledge, not your uploaded sources."
            >
              Not grounded in your sources
            </span>
          )}
```

Match the surrounding badge/pill styling already used in this file (copy the className shape from the existing action badge so it reads as one system).

- [ ] **Step 5: Run tests + typecheck + build**

Run: `npm run test -- suggestion-display && npx tsc --noEmit && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/suggestion-display.ts src/components/canvas/suggestion-card.tsx src/components/canvas/suggestion-display.test.ts
git commit -m "feat(cards): show a not-grounded chip on proposals with no cited sources"
```

---

## Phase F — Retire the single-shot suggester

### Task 13: Delete `run_chat_suggest`; final full-suite gates

**Files:**
- Modify: `backend/app/services/map_chat_suggest.py`
- Modify: `backend/app/api/v2/process_maps.py` (drop the dead import)

- [ ] **Step 1: Confirm nothing but the retired branch used it**

Run: `cd backend && grep -rn "run_chat_suggest\|from app.services.map_chat_suggest" app/ tests/`
Expected: only the (now-removed) endpoint import and the module's own definition. `MENTION_INSTRUCTIONS`/`PROPOSE_TOOL`/`SUGGEST_INSTRUCTIONS` were moved into `map_chat_agent.py` in Task 6 — confirm no remaining importer references them from `map_chat_suggest`.

- [ ] **Step 2: Delete `run_chat_suggest` and now-dead constants**

In `backend/app/services/map_chat_suggest.py`, remove `run_chat_suggest`, `PROPOSE_TOOL`, `SUGGEST_INSTRUCTIONS`, `MENTION_INSTRUCTIONS`, and the module-level Anthropic client/`_get_client` if unused elsewhere. If the whole module is now empty, delete the file and remove its import from `process_maps.py`. (The per-node `ai_edit_node` helpers live in a different module — `map_reconcile`/`ai_edit` — and are NOT touched.)

- [ ] **Step 3: Remove the dead endpoint import**

In `backend/app/api/v2/process_maps.py`, delete `from app.services.map_chat_suggest import run_chat_suggest` and any now-unused `ChatMode` import if the enum is no longer referenced in the file (keep it if the request schema still types `mode: ChatMode`).

- [ ] **Step 4: Full backend suite**

Run: `cd backend && source .venv/bin/activate && pytest -q`
Expected: PASS

- [ ] **Step 5: Full frontend gates**

Run: `npm run test && npx tsc --noEmit && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/map_chat_suggest.py backend/app/api/v2/process_maps.py
git commit -m "refactor(chat): retire the single-shot suggester; the loop is the only path"
```

- [ ] **Step 7: Push and open the PR**

```bash
git push -u origin design/agent-loop-write-propose
gh pr create --repo ewise123/processreengineering --base main \
  --title "Agent tool loop — write/propose loop (Layer 0.5)" \
  --body "Implements docs/superpowers/specs/2026-07-01-agent-loop-write-propose-design.md"
```

Then run `/autofix-pr` (per repo convention). Do NOT merge without explicit user permission.

---

## Self-Review

**Spec coverage:**
- §2/§3 one coarse `propose_changes` tool → Task 6. ✓
- §4.2 three new op kinds (backend schema) → Task 3; (build passthrough) Tasks 4-5; (frontend) Tasks 8-11. ✓
- §5 in-loop validation with self-correcting errors → Tasks 4 (`validate_proposal_batch`) + 6 (loop feeds verdict back). ✓
- §6 proposals populate `suggestions[]`; grounded chip on card → Task 7 (response) + Task 12 (chip). ✓
- §7 backend additions: `EdgeUpdate.condition_text` → Task 1; `delete_lane` `ai_applied` → Task 2. ✓
- §8 ops-per-run cap → Task 6 (`MAX_PROPOSED_OPS`). ✓ Existing budget caps reused (no change needed). ✓
- §2/§3 endpoint `ChatMode` branch collapses; loop is the only path → Task 7. ✓
- §F retire single-shot suggester → Task 13. ✓
- `remove_lane` non-undoable/confirm → Task 9 (`DELETE_OPS`). ✓

**Placeholder scan:** No TBD/TODO. Each code step shows concrete code. The two spots that say "adapt to the file's existing fixture" (Tasks 1, 2, 7) name the exact existing test to copy from — acceptable because the fixtures already exist and vary by file; the reviewer copies a named sibling.

**Type consistency:** `MutationStep.update_node.nodeType` (Task 9) matches the executor read `step.nodeType` (Task 10) and the `opToSteps` write (Task 9). `delete_lane`/`update_edge_condition` step shapes match across `opToSteps`, `stepRealRefs`, `withReason`, and the executor. `validate_proposal_batch(ops, ctx, *, start_index)` signature matches its call in Task 6 and its test in Task 4. `isProposalGrounded` matches its test (Task 12). `AgentResult.proposals`/`group_summaries` match the endpoint reads in Task 7.

**Scope check:** One cohesive increment (the write loop). Phase A ships independently useful op-coverage; Phases B–F build the loop on top. Ordered so each phase leaves the suite green.
