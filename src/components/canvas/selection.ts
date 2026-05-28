/** Axis-aligned rectangle in world coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Minimal positioned node for hit-testing (resolved absolute coords). */
export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Build a normalized (non-negative w/h) rect from two world-space corners. */
export function normalizeMarquee(
  startX: number,
  startY: number,
  currX: number,
  currY: number
): Rect {
  return {
    x: Math.min(startX, currX),
    y: Math.min(startY, currY),
    w: Math.abs(currX - startX),
    h: Math.abs(currY - startY),
  };
}

/** AABB overlap test; touching edges count as intersecting. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.w &&
    a.x + a.w >= b.x &&
    a.y <= b.y + b.h &&
    a.y + a.h >= b.y
  );
}

/** Ids of nodes whose bbox intersects the marquee rect. */
export function nodesInMarquee(nodes: PositionedNode[], marquee: Rect): string[] {
  return nodes
    .filter((n) => rectsIntersect(marquee, n))
    .map((n) => n.id);
}
