/**
 * "Reset routes": which connectors in a selection have a hand-dragged bend
 * to clear. A connector counts when it's selected itself, or when both of
 * its ends are selected (marquee-selecting a run of steps picks up the
 * connectors between them). Clearing the bend returns it to the standard
 * L-shaped route; the sides pinned for a rework loop are left alone.
 *
 * Pure: no React, no DOM.
 */

export interface RouteEdge {
  id: string;
  from: string;
  to: string;
  bendX?: number | null;
  bendY?: number | null;
}

export interface RouteReset {
  id: string;
  /** The bends before the reset, for undo. */
  bendX: number | null;
  bendY: number | null;
}

export function routesToReset(edges: RouteEdge[], selectedIds: ReadonlySet<string>): RouteReset[] {
  const out: RouteReset[] = [];
  for (const e of edges) {
    const inSelection = selectedIds.has(e.id) || (selectedIds.has(e.from) && selectedIds.has(e.to));
    const bent = (e.bendX ?? null) !== null || (e.bendY ?? null) !== null;
    if (inSelection && bent) out.push({ id: e.id, bendX: e.bendX ?? null, bendY: e.bendY ?? null });
  }
  return out;
}
