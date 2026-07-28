# Require a Reason on Delete (node / edge / lane)

**Status:** Design approved 2026-07-28. Lands on branch `feat/require-reason-on-delete`
(branched from `main` @ `c287e26`). Nothing merges to `main` without explicit OK.

**Issue:** [#53](https://github.com/ewise123/processreengineering/issues/53) — milestone *Now*,
labels `P1:agent-loop`, `type:feature`, `area:backend`, `area:frontend`, `size:S`.

**Explicitly not this issue:** [#54](https://github.com/ewise123/processreengineering/issues/54)
(delete-with-consequences: impact preview, gap-marking, replacement offers). That is parked in
*Later*. This spec covers the reason and nothing else.

---

## Problem

Editing a step requires a reason. Deleting one does not.

Renaming a step, retyping it, moving it between lanes, relabelling an edge, or renaming a lane all
422 without a `reason`, and the reason lands on the `change_event` that records the edit
(`process_maps.py:952`, `:1088`, `:1206`). Delete is the single most provenance-critical edit in
the tool — it is the only one that removes evidence from the map — and it is the one edit that
records nothing but the literal string `"Deleted"`.

The result is a change log that can explain why a step was renamed but not why it disappeared.
For a tool whose north star is a grounded, tracked process map, that is the wrong gap to leave open.

## Governing principle

**A delete is an edit, and every edit explains itself.** The rule already exists for semantic
edits; this extends it to the edit that destroys the most information. The reason requirement is
hard (422), not advisory, so it holds for API callers as well as the canvas.

---

## 1. Backend contract

### 1.1 Request body

One shared schema in `backend/app/schemas/process_map.py`, alongside the existing `*Update`
models:

```python
class DeleteRequest(BaseModel):
    """Body for the delete endpoints. `reason` is required in practice — the
    handler 422s on a missing or blank one — but the field is declared optional
    so the rejection carries our own message rather than a pydantic envelope."""

    reason: str | None = Field(default=None, max_length=2000)
    ai_applied: bool = False
```

The optional typing is deliberate and matches `NodeUpdate` / `EdgeUpdate` / `LaneUpdate`: those
declare `reason: str | None` and enforce it in the handler so the client sees
*"A reason is required when changing a step's name, description, type, or lane."* instead of a
`loc`/`msg`/`type` array. Deletes follow the same pattern for the same reason.

Each endpoint accepts the body as optional:

```python
payload: Annotated[DeleteRequest | None, Body()] = None
```

so a client that sends **no body at all** — every caller as of today — gets the same clear 422 as
one that sends a blank reason, rather than a bare pydantic "field required".

**Why a body and not a query param or a `POST /delete` route.** A query param would put
free-text prose (up to 2000 chars) into the URL and therefore into every access log; a
`POST /{id}/delete` route would break REST symmetry with the three sibling `DELETE` endpoints for
no gain. A JSON body keeps the delete payload shape identical to the edit payload shape
(`{reason, ai_applied}`), which is what the frontend `request()` helper already serializes for
`PATCH` — `src/lib/api.ts:70` sets the body from `init.json` for any method, so `DELETE` needs no
transport work.

### 1.2 The gate

A module-level helper in `process_maps.py`, next to the existing change-recording helpers:

```python
def _require_delete_reason(payload: DeleteRequest | None, message: str) -> str:
    """Return the trimmed reason, or 422 with `message` if it's missing/blank."""
    reason = (payload.reason or "").strip() if payload else ""
    if not reason:
        raise HTTPException(status_code=422, detail=message)
    return reason
```

Per-endpoint messages:

| Endpoint | Location | 422 `detail` |
|---|---|---|
| `delete_node` | `process_maps.py:1139` | `A reason is required to delete a step.` |
| `delete_edge` | `process_maps.py:1110` | `A reason is required to delete a connection.` |
| `delete_lane` | `process_maps.py:1576` | `A reason is required to delete a lane.` |

The returned reason replaces the hardcoded `reason="Deleted"` in each endpoint's `record_change`
call, and `payload.ai_applied` drives `source` / `actor_kind` the same way the edit paths do:

```python
source=ChangeSource.CHAT.value if ai_applied else ChangeSource.MANUAL.value,
actor_kind=ChangeActorKind.AI.value if ai_applied else ChangeActorKind.USER.value,
```

Today the delete paths pass `source=ChangeSource.MANUAL.value` unconditionally and omit
`actor_kind` entirely, so an AI-applied delete is currently indistinguishable from a hand delete
in the log. Threading `ai_applied` fixes that as a direct consequence of this work.

### 1.3 Ordering within each handler

The gate runs **before any mutation**, so a rejected delete leaves nothing behind. Concretely:

- `delete_node` — gate before the `Review` cleanup `DELETE` at `:1162`.
- `delete_lane` — gate before the node-reassignment `UPDATE` at `:1603`.
- `delete_edge` — no pre-mutation work; gate sits with the other validation.

The existing edit paths reach for `db.rollback()` before raising because they mutate the ORM
objects first and only then discover the reason is missing. Deletes have no such problem: the gate
is pure validation and runs first, so **no `rollback()` is needed** and none should be added.

One deliberate exception to "gate first": in `delete_lane`, the structural
*"Cannot delete the last remaining lane"* guard (`:1596`) stays **ahead** of the reason gate. That
delete can never succeed, so demanding a reason for it first would cost the caller a round trip to
learn something we already know. Provenance gates guard real state changes; they do not guard
impossibilities.

### 1.4 Coordination with `feat/provenance-v2-schema` (#71)

This change touches only the *arguments* passed to `record_change`. It adds no column, no
migration, and no new event kind — the `DELETE` kind and the `reason` column both already exist.
The prov-v2 branch extends `record_change` additively (`event_kind`, `group_id`,
`related_event_id`, `cited_targets`), so the two are compatible by construction. The only overlap
is textual, inside the three delete functions, and resolves as an ordinary merge.

---

## 2. Frontend

### 2.1 Shape of the change

The three delete implementations become **pure and reason-taking**:

```
deleteNodeImpl(id, reason)     // bpmn-canvas.tsx:296
deleteEdgeImpl(id, reason)     // bpmn-canvas.tsx:551
deleteLaneImpl(id, reason)     // bpmn-canvas.tsx:2291 (renamed from deleteLane)
```

Prompting lifts out into thin wrappers (`requestDeleteNode`, `requestDeleteEdge`,
`requestDeleteLane`, `requestDeleteSelection`) that call `promptReason(...)`, bail on `null`, and
delegate. This is the load-bearing decision: making `reason` a required parameter turns every one
of the ~12 call sites into a compile error until it states its reason, which is exactly the audit
we want. A default value, or an optional param, would let a call site silently keep writing
`"Deleted"`.

`deleteLane` also currently swallows its own errors in a `try/catch` with a toast. The wrapper
keeps that behavior; only the prompt is new.

### 2.2 Which paths prompt

| Surface | Entry point | Modal label |
|---|---|---|
| Properties panel Delete | `properties-panel.tsx:147` → handle `deleteNode` | Delete step |
| Delete / Backspace key | `bpmn-canvas.tsx:1074` → `deleteSelectionImpl` | count-aware (below) |
| Node context menu → Delete | `bpmn-canvas.tsx:2070` → `deleteSelectionImpl` | count-aware |
| Selection toolbar → Delete | page `:510` → handle `deleteSelection` | count-aware |
| Edge context menu → Delete | `bpmn-canvas.tsx:2087` | Delete connection |
| Lane rail kebab → Delete | page → `onDeleteLane` | Delete lane |

Count-aware labels come from a small pure module, `src/components/canvas/delete-reason.ts`:

```
deleteActionLabel({ nodes: 1, edges: 0 }) -> "Delete step"
deleteActionLabel({ nodes: 0, edges: 1 }) -> "Delete connection"
deleteActionLabel({ nodes: 0, edges: 3 }) -> "Delete 3 connections"
deleteActionLabel({ nodes: 2, edges: 0 }) -> "Delete 2 steps"
deleteActionLabel({ nodes: 2, edges: 3 }) -> "Delete 5 items"
```

A mixed selection collapses to "items" rather than enumerating both counts; the modal is a prompt,
not an inventory (that is #54's job).

**Multi-select prompts exactly once.** `deleteSelectionImpl` computes the node and edge id sets it
already computes today (`:596`–`:597`), prompts once with the count-aware label, and passes that
single reason to every `deleteNodeImpl` / `deleteEdgeImpl` call in the loop. Every resulting
`change_event` carries the same reason, which is the intended reading: one user decision, one
rationale, N recorded consequences.

**Node cascade is not prompted per edge.** Deleting a node FK-cascades its touching edges server
side; the node's reason covers the cascade. `deleteSelectionImpl` already skips edges a node
delete removed (`:604`), so no orphan prompt can fire.

### 2.3 Which paths auto-supply a reason

These are not user-intent deletes. They must never prompt — a modal here would be a bug, and in
the undo case an outright trap (undoing a create should not interrogate the user).

| Call site | Line | Reason passed |
|---|---|---|
| `delete_node` suggestion step | `:731` | `step.reason ?? APPLIED_REASON_FALLBACK`, `ai_applied: true` |
| `delete_edge` suggestion step | `:789` | `step.reason ?? APPLIED_REASON_FALLBACK`, `ai_applied: true` |
| `reroute_edge` internal delete | `:818` | `step.reason ?? APPLIED_REASON_FALLBACK`, `ai_applied: true` |
| Undo of AI `create_node` | `:764` | `REVERT_REASON` |
| Undo of AI `create_edge` | `:782` | `REVERT_REASON` |
| Undo of AI `create_lane` | `:863` | `REVERT_REASON` |
| Undo of `addProposedStep` | `:515` | `Undo of Add AI-proposed step` |
| Undo of `createEdgeImpl` | `:667` | `Undo of Create edge` |
| Redo of `deleteEdgeImpl` | `:584` | `Redo of Delete edge` |
| Paste undo (`remove()`) | `:2025`–`:2026` | `Undo of Paste` |

`APPLIED_REASON_FALLBACK` (`"Applied AI suggestion"`) and `REVERT_REASON`
(`"Reverted an applied AI suggestion"`) already exist at `bpmn-canvas.tsx:209`–`:210`. The
`Undo of …` / `Redo of …` strings follow the convention the edit paths already use
(`:369`–`:370`, `:636`–`:637`).

Note the `ai_applied` asymmetry: the forward suggestion steps set it, the `REVERT_REASON` undos do
not. That matches the existing edit inverses (`:724`, `:803`, `:877`), which pass `REVERT_REASON`
without `ai_applied`, and it is the correct reading — the AI made the change, but the *user* chose
to revert it.

The AI-applied deletes carry the suggestion's own rationale, which is strictly better provenance
than anything a prompt could collect — the user already saw and accepted that rationale on the
card.

### 2.4 Undo stays intact

- **Edge delete** remains undoable. `deleteEdgeImpl`'s recorded `do` re-deletes with a
  `Redo of …` reason; its `undo` recreates via `createEdge`, which takes no reason and is
  unchanged.
- **Node delete** remains deliberately non-undoable, as today.
- **Lane delete** remains non-undoable, as today.
- Undo entries that *perform* a delete as their inverse (the create-undo rows in §2.3) now pass an
  explicit reason and keep working unchanged.

### 2.5 The modal

`useReasonPrompt` gains an options argument:

```ts
promptReason(
  actionLabel: string,
  options?: { destructive?: boolean; description?: string }
): Promise<string | null>
```

Both options are carried in the hook state and consumed by `ReasonPromptDialog`, which for a
destructive prompt switches to:

- confirm button label **Delete**, `variant="destructive"`
- placeholder: *"e.g. Duplicate of the intake step"*
- a description matched to the target, since what a delete takes with it differs:

| Target | Description |
|---|---|
| step(s) / mixed selection | *"This removes the selection and any connections to it. Add a short reason — it's saved to the change log."* |
| connection(s) | *"This removes the connection. Add a short reason — it's saved to the change log."* |
| lane | *"This removes the lane; its steps move to the first remaining lane. Add a short reason — it's saved to the change log."* |

The dialog falls back to its current copy and default button when neither option is set, so the
existing rename / relane / retype prompts are untouched.

Everything else is unchanged: Cancel / Escape / overlay-click resolve `null` and abort the delete,
submit stays disabled on whitespace, Cmd+Enter submits. Because Cancel aborts, **the reason modal
is the confirm step** — there is no second "are you sure?" dialog. One dismissal per delete.

A cancelled delete needs no special handling in the Properties panel: `handleDelete`
(`properties-panel.tsx:147`) already resets its `deleting` flag in a `finally`, so the wrapper
resolving without deleting leaves the button live.

### 2.6 API and types

`src/lib/api.ts` — all three signatures take the body:

```ts
deleteNode: (projectId: UUID, nodeId: UUID, body: DeleteRequest) =>
  request<void>(`/api/v2/projects/${projectId}/nodes/${nodeId}`, {
    method: "DELETE",
    json: body,
  }),
```

`src/lib/types.ts` gains `DeleteRequest = { reason: string; ai_applied?: boolean }`. Note the
frontend type declares `reason` as **required** `string` even though the backend schema allows
null — the wire contract permits null so the server can return a good error; no frontend caller
should ever exercise that path, and the type should say so.

The canvas handle (`BpmnCanvasHandle`) keeps its current `deleteNode(id)` / `deleteSelection()`
signatures, now backed by the prompting wrappers. The Properties panel and the page need no
signature changes.

---

## 3. Testing

### 3.1 Backend — `backend/tests/test_delete_reason.py` (new)

Per target (node, edge, lane):

- `DELETE` with **no body** → 422, entity still present, **no `change_event` written**
- `DELETE` with `{"reason": "   "}` → 422, same assertions
- `DELETE` with a real reason → 204, entity gone, one `DELETE` `change_event` carrying that exact
  reason with `source="manual"`, `actor_kind="user"`
- `DELETE` with `{"reason": …, "ai_applied": true}` → `source="chat"`, `actor_kind="ai"`
- reason is stored trimmed

Plus:

- `delete_lane` on the last remaining lane returns the *"Cannot delete the last remaining lane"*
  422 even when no reason is supplied (asserts the guard-before-gate ordering in §1.3)
- `delete_node`'s `Review` rows survive a reason-rejected delete (asserts the gate-before-mutation
  ordering)

The "no `change_event` written" assertion is the one that catches a gate placed after
`record_change` — the failure mode that would quietly pollute the change log with phantom deletes.

### 3.2 Backend — existing tests to update

| File | Line | Change |
|---|---|---|
| `test_change_event_capture.py` | `:279`, `:304`, `:336` | pass a `DeleteRequest` payload; assert the reason reaches the event |
| `test_ai_edit.py` | `:266` | pass a payload to the direct `pm_api.delete_node` call |
| `test_stakeholder_review.py` | `:138`, `:160` | `client.delete(..., json={"reason": …})` |

These three files are the complete set. `test_node_claim_links.py:93` also issues a
`client.delete`, but
against `/nodes/{id}/claims/{claim_id}` — a different endpoint that this spec does not touch.

### 3.3 Frontend — vitest

Canvas tests in this repo are pure-logic, not rendered (`selection.test.ts`,
`suggestion-apply.test.ts` set the pattern), which is why the label logic lives in its own module.

- `delete-reason.test.ts` — the full `deleteActionLabel` table from §2.2, including singular /
  plural and the mixed-selection collapse
- `api.deleteNode` / `deleteEdge` / `deleteLane` send `method: "DELETE"` with the reason in a JSON
  body and `Content-Type: application/json` (fetch stubbed)

### 3.4 Manual verification

Run the app (`./run-local.sh`) and confirm end to end: panel delete prompts and the reason appears
in the change log; Cancel aborts with the step still on canvas; multi-select shows one modal;
Cmd+Z still restores a deleted edge; an AI suggestion containing a delete applies with no prompt
and logs the card's rationale.

---

## 4. Out of scope

**Cascaded-edge provenance.** Deleting a node FK-cascades its touching edges and writes **no**
`change_event` for them. The edges vanish from the log's point of view. This is a real pre-existing
hole, but it is a separate defect from the reason requirement and would roughly double this diff.
A follow-up issue gets filed: *node delete should log `DELETE` change_events for its cascaded
edges*, carrying the node's reason.

**Lane-delete node reassignment.** `delete_lane` moves the lane's nodes to a fallback lane
(`:1603`) and records no per-node lane-change event. Same category as the above; folded into the
same follow-up issue.

**Delete with consequences** (#54) — impact preview, gap-marking, replacement offers.

**Server-derived `ai_applied`** — the client still asserts it. Already tracked as worklist item
#16 in the agent-loop batch-2 design.
