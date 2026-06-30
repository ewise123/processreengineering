/** Pure helpers for the AI edit-this-step feature (SP-5a). */

import type { CanvasLane, CanvasNode } from "./types";

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

/** Pure placement: where a new node should land, given the current nodes/lanes
 * and an optional target lane + "near" node. Mirrors the canvas's placeNewNode
 * so a previewed add matches the committed result. Returns null if no lane. */
export function placeNewNodeIn(
  nodes: CanvasNode[],
  lanes: CanvasLane[],
  laneId: string | null,
  nearNodeId: string | null
): { laneId: string; x: number; relativeY: number } | null {
  const near = nearNodeId ? nodes.find((n) => n.id === nearNodeId) ?? null : null;
  const resolvedLane = laneId ?? near?.laneId ?? lanes[0]?.id ?? null;
  if (!resolvedLane) return null;
  if (near) {
    const pos = placeProposedStep({ x: near.x, relativeY: near.relativeY, w: near.w });
    return { laneId: resolvedLane, x: pos.x, relativeY: pos.relativeY };
  }
  const inLane = nodes.filter((n) => n.laneId === resolvedLane);
  const x = inLane.length ? Math.max(...inLane.map((n) => n.x + n.w)) + 60 : 80;
  return { laneId: resolvedLane, x, relativeY: 40 };
}
