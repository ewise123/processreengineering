/**
 * Tolerant drop-target picker.
 *
 * Given a cursor point and a list of candidate rectangles (shapes), decide
 * which shape the user meant to drop onto.  Exact hit-testing is too strict,
 * so a cursor just outside a shape still targets it, as long as it is within
 * a tolerance distance of that shape's edge.
 *
 * Pure module: no React, no DOM.
 */

/** A point in canvas coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** Candidate shape for drop-target picking. */
export interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Shortest distance from a point to the edge of an axis-aligned rectangle.
 * Returns 0 when the point is inside (or on the boundary of) the rectangle.
 */
function distanceToRect(p: Point, r: Rect): number {
  // Clamp the point to the nearest point on the rectangle.
  const cx = Math.max(r.x, Math.min(p.x, r.x + r.width));
  const cy = Math.max(r.y, Math.min(p.y, r.y + r.height));
  return Math.hypot(p.x - cx, p.y - cy);
}

/**
 * Return the id of the shape a drop at `point` should target, or null when
 * no candidate qualifies.
 *
 * Rules:
 *  1. A cursor inside a rectangle targets that rectangle.
 *  2. A cursor outside every rectangle still targets the nearest one,
 *     provided it is within `tolerance` of that rectangle's edge.
 *  3. When more than one rectangle qualifies, prefer the smaller one
 *     (by area) — a smaller shape is the more specific target.
 *  4. Beyond the tolerance, return null.
 *
 * The result is independent of the order of `candidates`.
 */
export function pickDropTarget(
  point: Point,
  candidates: Rect[],
  tolerance = 0
): string | null {
  let best: { id: string; area: number; dist: number } | null = null;

  for (const c of candidates) {
    const dist = distanceToRect(point, c);
    if (dist > tolerance + 1e-9) continue;

    const area = c.width * c.height;
    if (
      best === null ||
      area < best.area ||
      (area === best.area && dist < best.dist) ||
      (area === best.area && dist === best.dist && c.id < best.id)
    ) {
      best = { id: c.id, area, dist };
    }
  }

  return best ? best.id : null;
}
