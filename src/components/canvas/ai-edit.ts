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
