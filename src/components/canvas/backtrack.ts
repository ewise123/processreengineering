import type { ConnectSide } from "./shapes";

/** How far left of the source's center the target's center must sit before a
 * connection counts as a backtrack. Keeps near-vertical links as forward edges. */
export const BACKTRACK_DEADZONE_PX = 24;

export function isBacktrack(
  source: { x: number; w: number },
  target: { x: number; w: number },
  deadzone: number = BACKTRACK_DEADZONE_PX
): boolean {
  const sourceCenterX = source.x + source.w / 2;
  const targetCenterX = target.x + target.w / 2;
  return targetCenterX < sourceCenterX - deadzone;
}

/** Faces for an auto-drawn loop: the source face follows the grabbed handle
 * (top stays top; bottom/left/right default to bottom); the target face follows
 * which half of its box the cursor released over. */
export function deriveLoopSides(
  grabbedSide: ConnectSide,
  dropY: number,
  target: { y: number; h: number }
): { sourceSide: "top" | "bottom"; targetSide: "top" | "bottom" } {
  const sourceSide: "top" | "bottom" = grabbedSide === "top" ? "top" : "bottom";
  const targetSide: "top" | "bottom" =
    dropY < target.y + target.h / 2 ? "top" : "bottom";
  return { sourceSide, targetSide };
}
