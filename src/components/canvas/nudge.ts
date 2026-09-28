/**
 * Arrow-key nudging for selected steps. The selection moves as one rigid
 * group, and never leaves the lanes it's in: the move is cut short at the
 * first member that would hit its lane's top or bottom, or the lane headers
 * on the left. Keeping lanes unchanged makes a nudge a cosmetic move, so it
 * never asks for a reason.
 *
 * Pure: no React, no DOM.
 */

/** Arrow = a small step; Shift+Arrow = one background grid cell. */
export const NUDGE_SMALL = 4;
export const NUDGE_LARGE = 24;

/** Presses closer together than this are one undo entry. */
export const NUDGE_BURST_MS = 800;

export interface NudgeMember {
  id: string;
  x: number;
  relativeY: number;
  h: number;
  /** Height of the member's lane, or null when it has no lane (no y limit below). */
  laneH: number | null;
}

/** Arrow key → unit direction, or null for any other key. */
export function arrowDirection(key: string): { dx: number; dy: number } | null {
  switch (key) {
    case "ArrowLeft":
      return { dx: -1, dy: 0 };
    case "ArrowRight":
      return { dx: 1, dy: 0 };
    case "ArrowUp":
      return { dx: 0, dy: -1 };
    case "ArrowDown":
      return { dx: 0, dy: 1 };
    default:
      return null;
  }
}

/**
 * The shift actually applied: the requested one, shortened so that no member
 * leaves its lane or slides under the headers. A member already past a limit
 * (from an older drag) doesn't block moves back toward safety.
 */
export function clampNudge(
  members: NudgeMember[],
  dx: number,
  dy: number,
  minX: number
): { dx: number; dy: number } {
  let ax = dx;
  let ay = dy;
  for (const m of members) {
    if (ax < 0) ax = Math.max(ax, Math.min(0, minX - m.x));
    if (ay < 0) ay = Math.max(ay, Math.min(0, -m.relativeY));
    if (ay > 0 && m.laneH !== null) {
      ay = Math.min(ay, Math.max(0, m.laneH - m.h - m.relativeY));
    }
  }
  return { dx: ax, dy: ay };
}
