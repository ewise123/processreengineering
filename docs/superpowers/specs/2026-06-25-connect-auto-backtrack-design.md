# Connect-tool auto-backtrack edges

**Date:** 2026-06-25
**Branch:** `feat/rework-backtrack-edge`
**Status:** Approved design, pending implementation plan

## Problem

The canvas needs a way to draw a backtrack arrow: an edge that loops to an
*earlier* step (a rework/return loop), attaching to the top or bottom face of a
node rather than the left/right faces a normal forward arrow uses.

A first pass shipped this as a dedicated "Rework" tool. Testing it surfaced two
problems:

1. **Wrong mental model.** The user does not want a separate tool. The Connect
   tool should decide on its own: connect to an earlier step and it loops back;
   connect to a later step and it draws a normal arrow.
2. **Connections silently vanish.** Some drops produce no edge at all. Server
   logs show every edge POST returns 201, so nothing is rejected server-side.
   The misses are drops that never land on a target node, so no request fires.

## Goal

Fold backtrack drawing into the existing Connect tool with automatic
forward/backward detection, and make drops land reliably.

## Decisions

These were settled during brainstorming and are fixed inputs to the plan:

- **No separate tool.** Connect is the only edge tool. The Rework tool, its `R`
  shortcut, and its top/bottom handle restriction are removed.
- **Backward = target is to the left.** A connection is a backtrack when the
  target node's horizontal center sits left of the source node's center. A small
  dead-zone keeps a near-vertical connection (centers roughly aligned on x) as a
  forward edge rather than a loop.
- **Loop faces come from the handles.** The source face is the handle the user
  grabs (top handle → top, bottom handle → bottom). The target face is the half
  of the target the user releases over (top half → top, bottom half → bottom).
  A left/right handle or a body-drag with no clear top/bottom intent defaults the
  source face to bottom.

## Behavior

### Forward connection (unchanged)

Target center x ≥ source center x (within the dead-zone). Creates a normal
`flow` edge with geometric auto-routing, byte-for-byte today's behavior.

### Backward connection (new)

Target center x < source center x, beyond the dead-zone. Creates a `rework`
edge:

- `source_side` = grabbed handle coerced to top/bottom (default bottom).
- `target_side` = top if released over the target's top half, else bottom.
- `edge_kind` = `rework`.

Rendered as an amber dashed orthogonal loop via `buildPinnedEdgePath`, with the
draggable mid-segment for reshaping (persisted as `bend_y`), and a change-log
entry of "Added rework connection".

### Live preview

While dragging, once the cursor is over a candidate target the preview reflects
the outcome: the amber dashed loop when the link would be backward, the normal
preview line when forward. The user sees the result before releasing.

### Drop reliability

The drop hit-test pads each target node's rectangle by a tolerance (~16px in
world units). If no padded rectangle contains the release point, the drop snaps
to the nearest node within a small radius. This removes the "disappears on
release" failure, which was caused by the cursor landing just outside the exact
node rectangle when aiming at an edge or handle.

## Scope

### Changes (frontend)

- Remove the Rework tool: toolbar button, `R` shortcut, `"rework"` member of
  `CanvasTool`, the `handleSides`/`REWORK_HANDLE_SIDES` restriction, and the
  `rework` flag plumbed through drag state as a *tool* concept.
- Move the forward/backward decision into the Connect drop handler:
  classification by x-comparison with dead-zone, face derivation from grab
  handle + drop position, and the `createEdgeImpl` rework opts.
- Update the live preview to show the loop-vs-forward outcome.
- Add the padded/nearest-node drop hit-test.

### Unchanged (backend + shared)

`source_side` / `target_side` / `edge_kind` columns, migration `0011`,
`EdgeCreate`/`EdgeUpdate`/`ProcessEdgeRead` schemas, `create_edge` persistence
and change-log, `buildPinnedEdgePath`, the amber/dashed styling and dedicated
arrowhead, the draggable bend, and the `CanvasEdge`/`ProcessEdge` type fields.
All backend tests stay valid.

## Testing

- **Classification:** target-left → backward; target-right → forward;
  centers within the dead-zone → forward.
- **Face derivation:** grab top + drop in top half → top/top; grab bottom + drop
  in bottom half → bottom/bottom; left/right grab → bottom source default.
- **Hit-test tolerance:** a release point just outside a node rectangle but
  within tolerance resolves to that node; a point near nothing resolves to none.
- Backend `pytest` suite unchanged.

## Cleanup

The stray `flow` edges created during manual testing are real persisted rows.
List them and delete on the user's confirmation so the test map starts clean.

## Out of scope

- Editing an existing edge's faces or flipping a forward edge into a rework edge
  after creation (the backend `EdgeUpdate` already accepts side changes; no UI
  for it now).
- Automatic obstacle-avoidance routing around intervening nodes. The draggable
  channel remains the manual escape hatch.
