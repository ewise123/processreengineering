/**
 * Alignment snapping for dragged steps: while a step (or a group) moves, pull
 * it onto the nearest line it shares with another step — left, centre or
 * right edges on one axis, top, middle or bottom on the other — and report
 * the guide lines to draw. Each axis snaps on its own, so a step can line up
 * horizontally with one neighbour and vertically with another.
 *
 * Pure: no React, no DOM. Boxes are in world units.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line to draw: vertical (`axis: "x"`, at an x) or horizontal (at a y). */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

/** Lines of a box along one axis: start edge, centre, end edge. */
function linesX(b: Box): number[] {
  return [b.x, b.x + b.w / 2, b.x + b.w];
}
function linesY(b: Box): number[] {
  return [b.y, b.y + b.h / 2, b.y + b.h];
}

/** Smallest shift within `threshold` that puts one of `mine` on one of `theirs`. */
function bestShift(mine: number[], others: number[][], threshold: number): number {
  let best = 0;
  let bestAbs = Infinity;
  for (const theirs of others) {
    for (const t of theirs) {
      for (const m of mine) {
        const d = t - m;
        const a = Math.abs(d);
        if (a <= threshold && a < bestAbs) {
          best = d;
          bestAbs = a;
        }
      }
    }
  }
  return best;
}

/** Tolerance for "on the same line" when listing guides (floating-point). */
const EPS = 0.5;

/**
 * Guides for a box that is already where it will land: one per line it
 * shares with another box, spanning both boxes (and every other box on that
 * line), so the user sees exactly what it lined up with.
 */
export function guidesFor(box: Box, others: Box[], eps = EPS): Guide[] {
  const guides: Guide[] = [];
  const add = (axis: "x" | "y", at: number, lo: number, hi: number) => {
    const g = guides.find((gg) => gg.axis === axis && Math.abs(gg.at - at) <= eps);
    if (g) {
      g.from = Math.min(g.from, lo);
      g.to = Math.max(g.to, hi);
    } else {
      guides.push({ axis, at, from: lo, to: hi });
    }
  };
  const mx = linesX(box);
  const my = linesY(box);
  for (const o of others) {
    for (const m of mx) {
      if (linesX(o).some((t) => Math.abs(t - m) <= eps)) {
        add("x", m, Math.min(box.y, o.y), Math.max(box.y + box.h, o.y + o.h));
      }
    }
    for (const m of my) {
      if (linesY(o).some((t) => Math.abs(t - m) <= eps)) {
        add("y", m, Math.min(box.x, o.x), Math.max(box.x + box.w, o.x + o.w));
      }
    }
  }
  return guides;
}

/**
 * How far to shift `moving` so it lines up with the nearest of `others`, per
 * axis, when a line is within `threshold` (world units — pass screen pixels
 * divided by the zoom, so snapping feels the same at every zoom). An axis
 * with nothing in range doesn't move. The guides describe the snapped box.
 */
export function computeSnap(moving: Box, others: Box[], threshold: number): SnapResult {
  if (others.length === 0 || threshold <= 0) return { dx: 0, dy: 0, guides: [] };
  const dx = bestShift(linesX(moving), others.map(linesX), threshold);
  const dy = bestShift(linesY(moving), others.map(linesY), threshold);
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy };
  return { dx, dy, guides: guidesFor(snapped, others) };
}
