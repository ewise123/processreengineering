/**
 * Connector geometry: orthogonal routes between two node rectangles.
 *
 * Every builder returns the route twice: `d`, the sharp-cornered path string
 * (kept stable because tests and the bend-drag handle are defined against it),
 * and `points`, the same route as corner points, which the renderer rounds
 * via `roundedPath`. Pure: no React, no DOM.
 */

import type { Pt } from "./rounded-path";

export type ConnectSide = "top" | "right" | "bottom" | "left";

/** Vertical faces a manual backtrack edge can be pinned to. */
export type VerticalSide = "top" | "bottom";

export type EdgeOrientation = "horizontal" | "vertical";

export interface SimpleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgePath {
  d: string;
  points: Pt[];
  midX: number;
  midY: number;
  orientation: EdgeOrientation;
  /** The two segment endpoints of the draggable middle segment, in the
   * canvas coordinate system. */
  midSegment: { x1: number; y1: number; x2: number; y2: number };
}

/** Below this gap on the perpendicular axis, the L-shape collapses to a
 * single straight segment. Picked to match a single grid-cell of slack. */
export const SNAP_STRAIGHT_THRESHOLD = 8;

/** How far past the node faces the default loop channel sits, before the user
 * drags it. Close enough that a backtrack loop hugs its row, far enough to
 * clear event labels under a shape and a step's "+" buttons. */
export const LOOP_OFFSET = 32;

/** A forced exit only makes an L-route when the target is at least this far
 * in front of the exit side; otherwise geometric routing takes over. */
const EXIT_CLEARANCE = 12;

function toD(points: Pt[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

function path(
  points: Pt[],
  rest: Omit<EdgePath, "d" | "points">
): EdgePath {
  return { d: toD(points), points, ...rest };
}

/**
 * Routing for a manually pinned backtrack/rework edge: leave the source's
 * top/bottom face, run along a horizontal channel, and enter the target's
 * top/bottom face — a clean orthogonal loop the user can reshape by dragging
 * the channel (persisted as bend_y). Unlike `buildEdgePath`'s geometric
 * branches, the faces here are fixed by the user, not derived from position.
 * `sourceOffset`/`targetOffset` slide the attachment along the face so the
 * loop doesn't sit on top of another connector using the same face.
 */
export function buildPinnedEdgePath(
  from: SimpleRect,
  to: SimpleRect,
  sourceSide: VerticalSide,
  targetSide: VerticalSide,
  bendY?: number | null,
  sourceOffset = 0,
  targetOffset = 0
): EdgePath {
  const sx = from.x + from.w / 2 + sourceOffset;
  const tx = to.x + to.w / 2 + targetOffset;
  const sFaceY = sourceSide === "bottom" ? from.y + from.h : from.y;
  const tFaceY = targetSide === "bottom" ? to.y + to.h : to.y;

  let channelY: number;
  if (typeof bendY === "number") {
    channelY = bendY;
  } else if (sourceSide === "bottom" && targetSide === "bottom") {
    channelY = Math.max(sFaceY, tFaceY) + LOOP_OFFSET;
  } else if (sourceSide === "top" && targetSide === "top") {
    channelY = Math.min(sFaceY, tFaceY) - LOOP_OFFSET;
  } else {
    // Mixed faces: bias the channel to the direction the source exits.
    channelY = sourceSide === "bottom" ? sFaceY + LOOP_OFFSET : sFaceY - LOOP_OFFSET;
  }

  return path(
    [
      { x: sx, y: sFaceY },
      { x: sx, y: channelY },
      { x: tx, y: channelY },
      { x: tx, y: tFaceY },
    ],
    {
      midX: (sx + tx) / 2,
      midY: channelY,
      orientation: "vertical",
      midSegment: { x1: sx, y1: channelY, x2: tx, y2: channelY },
    }
  );
}

export function sidePoint(rect: SimpleRect, side: ConnectSide): Pt {
  switch (side) {
    case "top":
      return { x: rect.x + rect.w / 2, y: rect.y };
    case "right":
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
    case "bottom":
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    case "left":
      return { x: rect.x, y: rect.y + rect.h / 2 };
  }
}

/**
 * Leave `from` through a chosen side and make one turn into the target: out
 * of the right side, across to the target's centre line, then down/up into
 * its top/bottom face; out of the bottom, down to the target's centre line,
 * then across into its near face. Used for gateway branches, which should
 * leave from different corners of the diamond. Returns null when the target
 * isn't in front of that side, so the caller can fall back to geometric
 * routing instead of drawing a line back through the source.
 */
export function buildExitPath(
  from: SimpleRect,
  to: SimpleRect,
  side: ConnectSide,
  targetOffset = 0
): EdgePath | null {
  const p = sidePoint(from, side);
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };

  if (side === "right" || side === "left") {
    const dir = side === "right" ? 1 : -1;
    if ((tc.x - p.x) * dir <= EXIT_CLEARANCE) return null;
    if (Math.abs(p.y - tc.y) < SNAP_STRAIGHT_THRESHOLD) {
      const entry = { x: dir > 0 ? to.x : to.x + to.w, y: p.y };
      return path([p, entry], {
        midX: (p.x + entry.x) / 2,
        midY: p.y,
        orientation: "horizontal",
        midSegment: { x1: p.x, y1: p.y, x2: entry.x, y2: p.y },
      });
    }
    let entryY: number;
    if (p.y < to.y) entryY = to.y;
    else if (p.y > to.y + to.h) entryY = to.y + to.h;
    else return null; // exit line runs into the target's side band: let a Z-route handle it
    const turnX = tc.x + targetOffset;
    const turn = { x: turnX, y: p.y };
    const entry = { x: turnX, y: entryY };
    return path([p, turn, entry], {
      midX: (p.x + turnX) / 2,
      midY: p.y,
      orientation: "horizontal",
      midSegment: { x1: turnX, y1: p.y, x2: turnX, y2: entryY },
    });
  }

  const dir = side === "bottom" ? 1 : -1;
  if ((tc.y - p.y) * dir <= EXIT_CLEARANCE) return null;
  const straightDown = () => {
    const entry = { x: p.x, y: dir > 0 ? to.y : to.y + to.h };
    return path([p, entry], {
      midX: p.x,
      midY: (p.y + entry.y) / 2,
      orientation: "vertical",
      midSegment: { x1: p.x, y1: p.y, x2: p.x, y2: entry.y },
    });
  };
  if (Math.abs(p.x - tc.x) < SNAP_STRAIGHT_THRESHOLD) return straightDown();
  let entryX: number;
  if (p.x < to.x) entryX = to.x;
  else if (p.x > to.x + to.w) entryX = to.x + to.w;
  else return straightDown(); // target sits squarely in front: drop straight in
  const turnY = tc.y + targetOffset;
  const turn = { x: p.x, y: turnY };
  const entry = { x: entryX, y: turnY };
  return path([p, turn, entry], {
    midX: p.x,
    midY: (p.y + turnY) / 2,
    orientation: "vertical",
    midSegment: { x1: p.x, y1: turnY, x2: entryX, y2: turnY },
  });
}

export function buildEdgePath(
  from: SimpleRect,
  to: SimpleRect,
  overrides?: {
    bendX?: number | null;
    bendY?: number | null;
    /** When both sides are pinned (top/bottom), routing follows the manual
     * loop in `buildPinnedEdgePath` instead of geometric auto-routing. */
    sourceSide?: VerticalSide | null;
    targetSide?: VerticalSide | null;
    /** Slide the source/target attachment along its face (world units), so
     * several connectors can share one side without stacking. */
    sourceOffset?: number;
    targetOffset?: number;
    /** Leave the source through this side (gateway branches). Ignored once
     * the user has dragged a bend, and when the target isn't in front of it. */
    sourceExit?: ConnectSide | null;
  }
): EdgePath {
  const sOff = overrides?.sourceOffset ?? 0;
  const tOff = overrides?.targetOffset ?? 0;
  if (overrides?.sourceSide && overrides?.targetSide) {
    return buildPinnedEdgePath(
      from,
      to,
      overrides.sourceSide,
      overrides.targetSide,
      overrides.bendY,
      sOff,
      tOff
    );
  }
  const hasBend =
    typeof overrides?.bendX === "number" || typeof overrides?.bendY === "number";
  if (overrides?.sourceExit && !hasBend) {
    const forced = buildExitPath(from, to, overrides.sourceExit, tOff);
    if (forced) return forced;
  }
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dx = tc.x - fc.x;
  const dy = tc.y - fc.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  if (horizontal) {
    const naturalExitX = dx >= 0 ? from.x + from.w : from.x;
    const naturalEntryX = dx >= 0 ? to.x : to.x + to.w;
    const exitY = fc.y + sOff;
    const targetY = tc.y + tOff;
    // Snap-to-straight: when source/target are aligned on the cross axis,
    // the L-shape's two parallel segments collapse into one straight line.
    if (Math.abs(exitY - targetY) < SNAP_STRAIGHT_THRESHOLD) {
      const y = (exitY + targetY) / 2;
      return path(
        [
          { x: naturalExitX, y },
          { x: naturalEntryX, y },
        ],
        {
          midX: (naturalExitX + naturalEntryX) / 2,
          midY: y,
          orientation: "horizontal",
          midSegment: { x1: naturalExitX, y1: y, x2: naturalEntryX, y2: y },
        }
      );
    }
    const naturalMidX = (naturalExitX + naturalEntryX) / 2;
    const bendX =
      typeof overrides?.bendX === "number"
        ? overrides.bendX
        : naturalMidX;
    // Source exit side flips to face whichever side of source the bend is on,
    // so the path never re-enters source.
    const exitX = bendX >= fc.x ? from.x + from.w : from.x;
    // If the user dragged the bend so it's inside the target's horizontal
    // span, snap entry to top or bottom (whichever the source is on the
    // other side of). Arrow lands perpendicular to that face.
    if (bendX > to.x && bendX < to.x + to.w) {
      const enterFromTop = exitY <= tc.y;
      const entryY = enterFromTop ? to.y : to.y + to.h;
      return path(
        [
          { x: exitX, y: exitY },
          { x: bendX, y: exitY },
          { x: bendX, y: entryY },
        ],
        {
          midX: bendX,
          midY: (exitY + entryY) / 2,
          orientation: "horizontal",
          midSegment: { x1: bendX, y1: exitY, x2: bendX, y2: entryY },
        }
      );
    }
    const entryX = bendX < to.x ? to.x : to.x + to.w;
    const entryY = targetY;
    return path(
      [
        { x: exitX, y: exitY },
        { x: bendX, y: exitY },
        { x: bendX, y: entryY },
        { x: entryX, y: entryY },
      ],
      {
        midX: bendX,
        midY: (exitY + entryY) / 2,
        orientation: "horizontal",
        midSegment: { x1: bendX, y1: exitY, x2: bendX, y2: entryY },
      }
    );
  }
  const naturalExitY = dy >= 0 ? from.y + from.h : from.y;
  const naturalEntryY = dy >= 0 ? to.y : to.y + to.h;
  const exitX = fc.x + sOff;
  const targetX = tc.x + tOff;
  if (Math.abs(exitX - targetX) < SNAP_STRAIGHT_THRESHOLD) {
    const x = (exitX + targetX) / 2;
    return path(
      [
        { x, y: naturalExitY },
        { x, y: naturalEntryY },
      ],
      {
        midX: x,
        midY: (naturalExitY + naturalEntryY) / 2,
        orientation: "vertical",
        midSegment: { x1: x, y1: naturalExitY, x2: x, y2: naturalEntryY },
      }
    );
  }
  const naturalMidY = (naturalExitY + naturalEntryY) / 2;
  const bendY =
    typeof overrides?.bendY === "number" ? overrides.bendY : naturalMidY;
  const exitY = bendY >= fc.y ? from.y + from.h : from.y;
  if (bendY > to.y && bendY < to.y + to.h) {
    const enterFromLeft = exitX <= tc.x;
    const entryX = enterFromLeft ? to.x : to.x + to.w;
    return path(
      [
        { x: exitX, y: exitY },
        { x: exitX, y: bendY },
        { x: entryX, y: bendY },
      ],
      {
        midX: (exitX + entryX) / 2,
        midY: bendY,
        orientation: "vertical",
        midSegment: { x1: exitX, y1: bendY, x2: entryX, y2: bendY },
      }
    );
  }
  const entryY = bendY < to.y ? to.y : to.y + to.h;
  const entryX = targetX;
  return path(
    [
      { x: exitX, y: exitY },
      { x: exitX, y: bendY },
      { x: entryX, y: bendY },
      { x: entryX, y: entryY },
    ],
    {
      midX: (exitX + entryX) / 2,
      midY: bendY,
      orientation: "vertical",
      midSegment: { x1: exitX, y1: bendY, x2: entryX, y2: bendY },
    }
  );
}
