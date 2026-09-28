/**
 * Where a new step goes: beside its source for Tab ("next step"), or under
 * the pointer for a double-click / palette click. Positions are in the
 * canvas's lane-relative form (`x` world, `relativeY` from the lane top).
 * Pure: no React, no DOM.
 */

export interface PlacedRect {
  x: number;
  relativeY: number;
  w: number;
  h: number;
}

export interface LaneBox {
  id: string;
  y: number;
  h: number;
  collapsed?: boolean;
}

/** Horizontal gap between a step and the next one Tab creates. */
export const STEP_GAP = 80;
/** Width of the lane header strip; nothing is placed over it. */
export const LANE_HEADER_W = 44;
/** Breathing room kept around existing steps when finding a free slot. */
const CLEARANCE = 16;
/** Vertical step when the slot beside the source is taken. */
const STACK_GAP = 24;

function overlaps(a: PlacedRect, b: PlacedRect): boolean {
  return (
    a.x < b.x + b.w + CLEARANCE &&
    b.x < a.x + a.w + CLEARANCE &&
    a.relativeY < b.relativeY + b.h + CLEARANCE &&
    b.relativeY < a.relativeY + a.h + CLEARANCE
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The slot for the step after `source`, in the same lane: one gap to its
 * right, centred on the source's middle so the connector runs straight. If
 * that's taken (a second Tab from the same step, or a crowded lane), try
 * lower in the lane, then another column to the right.
 */
export function nextStepSlot(
  source: PlacedRect,
  size: { w: number; h: number },
  laneNodes: PlacedRect[],
  laneH: number,
  gap: number = STEP_GAP
): { x: number; relativeY: number } {
  const maxY = Math.max(0, laneH - size.h);
  const centredY = clamp(source.relativeY + source.h / 2 - size.h / 2, 0, maxY);
  let x = source.x + source.w + gap;
  for (let col = 0; col < 20; col++) {
    for (let y = centredY; y <= maxY + 0.01; y += size.h + STACK_GAP) {
      const slot = { x, relativeY: y, w: size.w, h: size.h };
      if (!laneNodes.some((n) => overlaps(slot, n))) return { x, relativeY: y };
    }
    x += size.w + gap;
  }
  return { x, relativeY: centredY };
}

/**
 * Turn a world point (double-click, palette click) into a slot centred on it
 * in the lane under it. Null when the point is outside every lane, over a
 * collapsed lane, or over the lane headers.
 */
export function pointToLaneSlot(
  world: { x: number; y: number },
  lanes: LaneBox[],
  size: { w: number; h: number }
): { laneId: string; x: number; relativeY: number } | null {
  if (world.x < LANE_HEADER_W) return null;
  const lane = lanes.find((l) => world.y >= l.y && world.y < l.y + l.h);
  if (!lane || lane.collapsed) return null;
  return {
    laneId: lane.id,
    x: Math.max(LANE_HEADER_W + 8, world.x - size.w / 2),
    relativeY: clamp(world.y - lane.y - size.h / 2, 0, Math.max(0, lane.h - size.h)),
  };
}
