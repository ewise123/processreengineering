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

// ── Quick add: the "+" on a step's free sides ──────────────────────────

export type QuickSide = "top" | "right" | "bottom" | "left";

/** A step on the map, as placement sees it. */
export interface PlacedStep extends PlacedRect {
  id: string;
  laneId: string;
}

/** Everything quick add changes besides creating the step. */
export interface QuickAddPlan {
  laneId: string;
  x: number;
  relativeY: number;
  /** "after": source → new step. "before": new step → source (left side). */
  link: "after" | "before";
  /** Steps nudged to make room (world units, applied to x / relativeY). */
  moves: { id: string; dx: number; dy: number }[];
  /** A lane made taller to fit the new step. */
  growLane: { laneId: string; toH: number } | null;
}

/** Leftmost x a step may sit at: just clear of the lane headers. */
const MIN_X = LANE_HEADER_W + 8;
/** Room kept under a step added at the bottom of a lane that had to grow. */
const GROW_MARGIN = 16;

/** The sides of each step that already carry a connector. */
export function occupiedSides(
  edges: { id: string; from: string; to: string }[],
  routes: Map<string, { sourceSide: QuickSide; targetSide: QuickSide }>
): Map<string, Set<QuickSide>> {
  const out = new Map<string, Set<QuickSide>>();
  const add = (id: string, side: QuickSide) => {
    const set = out.get(id) ?? new Set<QuickSide>();
    set.add(side);
    out.set(id, set);
  };
  for (const e of edges) {
    const r = routes.get(e.id);
    if (!r) continue;
    add(e.from, r.sourceSide);
    add(e.to, r.targetSide);
  }
  return out;
}

/** The shape a "+" adds: the same one, except a Start or End event adds a
 * task (a second Start straight after Start is never what's wanted). */
export function quickAddShape(type: string): string {
  return type === "event_start" || type === "event_end" ? "task" : type;
}

/** First free slot at `x0` or further along `dir`, scanning down the lane at
 * each column. Null when every column that fits is taken. */
function scanColumns(
  x0: number,
  dir: 1 | -1,
  y0: number,
  size: { w: number; h: number },
  others: PlacedRect[],
  laneH: number,
  minX: number,
  columns = 20
): { x: number; relativeY: number } | null {
  const maxY = Math.max(0, laneH - size.h);
  let x = x0;
  for (let col = 0; col < columns; col++) {
    if (x < minX) return null;
    for (let y = y0; y <= maxY + 0.01; y += size.h + STACK_GAP) {
      const slot = { x, relativeY: y, w: size.w, h: size.h };
      if (!others.some((n) => overlaps(slot, n))) return { x, relativeY: y };
    }
    x += dir * (size.w + STEP_GAP);
  }
  return null;
}

/**
 * Where the step added by the "+" on `side` of `source` goes, and what moves
 * to make room.
 *
 * - right: the next step in the same lane (Tab's slot).
 * - left: a step before it in the same lane. If there's no free slot between
 *   the headers and the source, the new step takes the source's place and the
 *   source plus everything to its right in the lane shifts right.
 * - top / bottom: a hand-off into the lane above / below, level with the
 *   source. With no lane there, it stacks in the same lane, and the lane
 *   grows (pushing its steps down, for the top) when there isn't room.
 *
 * `lanes` must be in top-to-bottom order; collapsed lanes are skipped over.
 */
export function quickAddSlot(args: {
  side: QuickSide;
  source: PlacedStep;
  size: { w: number; h: number };
  lanes: LaneBox[];
  steps: PlacedStep[];
}): QuickAddPlan {
  const { side, source, size, lanes, steps } = args;
  const lane = lanes.find((l) => l.id === source.laneId);
  const laneH = lane?.h ?? source.relativeY + source.h;
  const inLane = (id: string) => steps.filter((s) => s.laneId === id && s.id !== source.id);
  const same = inLane(source.laneId);
  const withSource = [...same, source];
  const centredY = clamp(source.relativeY + source.h / 2 - size.h / 2, 0, Math.max(0, laneH - size.h));
  const plan = (p: Partial<QuickAddPlan> & { laneId: string; x: number; relativeY: number }): QuickAddPlan => ({
    link: "after",
    moves: [],
    growLane: null,
    ...p,
  });

  if (side === "right") {
    return plan({ laneId: source.laneId, ...nextStepSlot(source, size, withSource, laneH) });
  }

  if (side === "left") {
    const free = scanColumns(source.x - STEP_GAP - size.w, -1, centredY, size, withSource, laneH, MIN_X);
    if (free) return plan({ laneId: source.laneId, ...free, link: "before" });
    // Insert: take the source's place; it and everything after it move right.
    const dx = size.w + STEP_GAP;
    const moves = withSource
      .filter((s) => s.x >= source.x - 0.5)
      .map((s) => ({ id: s.id, dx, dy: 0 }));
    return plan({ laneId: source.laneId, x: Math.max(MIN_X, source.x), relativeY: centredY, link: "before", moves });
  }

  // top / bottom
  const idx = lanes.findIndex((l) => l.id === source.laneId);
  const step = side === "top" ? -1 : 1;
  let neighbour: LaneBox | undefined;
  for (let i = idx + step; i >= 0 && i < lanes.length; i += step) {
    if (!lanes[i].collapsed) {
      neighbour = lanes[i];
      break;
    }
  }
  const centreX = Math.max(MIN_X, source.x + source.w / 2 - size.w / 2);
  if (idx !== -1 && neighbour) {
    const y = Math.max(0, (neighbour.h - size.h) / 2);
    const slot =
      scanColumns(centreX, 1, y, size, inLane(neighbour.id), neighbour.h, MIN_X) ?? {
        x: centreX,
        relativeY: y,
      };
    return plan({ laneId: neighbour.id, ...slot });
  }

  // No lane that way: stack in the same lane, growing it when needed.
  if (side === "bottom") {
    const y = source.relativeY + source.h + STACK_GAP;
    const slot = { x: centreX, relativeY: y, w: size.w, h: size.h };
    const x = same.some((n) => overlaps(slot, n))
      ? (scanColumns(centreX, 1, y, size, withSource, y + size.h, MIN_X)?.x ?? centreX)
      : centreX;
    const need = y + size.h + GROW_MARGIN;
    return plan({
      laneId: source.laneId,
      x,
      relativeY: y,
      growLane: need > laneH ? { laneId: source.laneId, toH: need } : null,
    });
  }
  const y = source.relativeY - STACK_GAP - size.h;
  if (y >= 0) {
    const slot = { x: centreX, relativeY: y, w: size.w, h: size.h };
    if (!same.some((n) => overlaps(slot, n))) return plan({ laneId: source.laneId, x: centreX, relativeY: y });
  }
  // Not enough room above: grow the lane and push its steps down.
  const push = Math.max(0, -y) + (y >= 0 ? size.h + STACK_GAP : 0);
  return plan({
    laneId: source.laneId,
    x: centreX,
    relativeY: Math.max(0, y + push),
    moves: withSource.map((s) => ({ id: s.id, dx: 0, dy: push })),
    growLane: { laneId: source.laneId, toH: laneH + push },
  });
}
