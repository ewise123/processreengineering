/**
 * Orthogonal polyline → SVG path with rounded corners.
 *
 * Edge routing works in sharp right-angle points (easy to reason about, and
 * what the bend-drag and tests pin down). Rendering then softens each corner
 * with a quadratic curve so connectors read as drawn lines rather than
 * stitched segments. Pure: no React, no DOM.
 */

export interface Pt {
  x: number;
  y: number;
}

/** Default corner radius in world units. */
export const CORNER_RADIUS = 10;

const EPS = 0.01;

function same(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
}

/** True when b sits on the straight line from a to c (no turn at b). */
function collinear(a: Pt, b: Pt, c: Pt): boolean {
  return Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) < EPS;
}

/** Drop repeated points and points that don't turn the line. */
export function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    if (out.length && same(out[out.length - 1], p)) continue;
    while (out.length >= 2 && collinear(out[out.length - 2], out[out.length - 1], p)) {
      out.pop();
    }
    out.push(p);
  }
  return out;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Point `d` along the segment from a toward b. */
function toward(a: Pt, b: Pt, d: number): Pt {
  const len = dist(a, b);
  if (len === 0) return a;
  return { x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len };
}

const fmt = (n: number) => Number(n.toFixed(2));

/**
 * Build a path through `points`, rounding each interior corner. The radius at
 * a corner is capped at half of the shorter neighbouring segment, so short
 * jogs never overshoot or loop back on themselves.
 */
export function roundedPath(points: Pt[], radius: number = CORNER_RADIUS): string {
  const pts = simplify(points);
  if (pts.length === 0) return "";
  const parts = [`M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const r = Math.max(0, Math.min(radius, dist(prev, cur) / 2, dist(cur, next) / 2));
    if (r < EPS) {
      parts.push(`L ${fmt(cur.x)} ${fmt(cur.y)}`);
      continue;
    }
    const a = toward(cur, prev, r);
    const b = toward(cur, next, r);
    parts.push(`L ${fmt(a.x)} ${fmt(a.y)}`, `Q ${fmt(cur.x)} ${fmt(cur.y)} ${fmt(b.x)} ${fmt(b.y)}`);
  }
  if (pts.length > 1) {
    const last = pts[pts.length - 1];
    parts.push(`L ${fmt(last.x)} ${fmt(last.y)}`);
  }
  return parts.join(" ");
}

/** Total length of a polyline. */
export function polylineLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** The point `d` units along a polyline from its start (clamped to its ends). */
export function pointAlong(points: Pt[], d: number): Pt {
  if (points.length === 0) return { x: 0, y: 0 };
  let remaining = Math.max(0, d);
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1], points[i]);
    if (remaining <= seg) return toward(points[i - 1], points[i], remaining);
    remaining -= seg;
  }
  return points[points.length - 1];
}
