export interface RectLike {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Distance from a point to the nearest edge of a rect; 0 when inside. */
export function distanceToRect(
  px: number,
  py: number,
  r: { x: number; y: number; w: number; h: number }
): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * The candidate whose rectangle is nearest the point, provided that distance is
 * within `tolerance` world units (0 = the point must be inside). Returns its id,
 * or null when no candidate qualifies. Callers exclude the source node from
 * `candidates` so an edge can't target itself.
 */
export function pickDropTargetId(
  px: number,
  py: number,
  candidates: RectLike[],
  tolerance = 20
): string | null {
  let bestId: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = distanceToRect(px, py, c);
    if (d < bestDist) {
      bestDist = d;
      bestId = c.id;
    }
  }
  return bestDist <= tolerance ? bestId : null;
}
