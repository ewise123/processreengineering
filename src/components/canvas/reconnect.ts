/**
 * Moving one end of a placed arrow to another step. Pure: the canvas asks
 * what a drop would do, then applies it (and its undo).
 */
import { deriveLoopSides, isBacktrack } from "./backtrack";
import type { ConnectSide } from "./shapes";
import type { CanvasEdge } from "./types";

export type EdgeEnd = "source" | "target";

type Box = { x: number; y: number; w: number; h: number };

/** Everything a reconnect changes, so undo can put all of it back. */
export interface EdgeEnds {
  from: string;
  to: string;
  kind: "flow" | "rework";
  sourceSide: "top" | "bottom" | null;
  targetSide: "top" | "bottom" | null;
  bendX: number | null;
  bendY: number | null;
}

/** Why a drop leaves the arrow where it was. */
export type ReconnectMiss = "none" | "same" | "self" | "duplicate";

export type ReconnectPlan = { ok: true; next: EdgeEnds } | { ok: false; why: ReconnectMiss };

export function edgeEnds(edge: CanvasEdge): EdgeEnds {
  return {
    from: edge.from,
    to: edge.to,
    kind: edge.kind === "rework" ? "rework" : "flow",
    sourceSide: edge.sourceSide ?? null,
    targetSide: edge.targetSide ?? null,
    bendX: edge.bendX ?? null,
    bendY: edge.bendY ?? null,
  };
}

const half = (y: number, box: Box): "top" | "bottom" =>
  y < box.y + box.h / 2 ? "top" : "bottom";

/**
 * What dropping `end` of `edge` on step `dropId` does. The arrow keeps its
 * label, colour and condition; its bend resets, and whether it is a backtrack
 * loop is worked out again the way drawing one does.
 */
export function planReconnect({
  edge,
  end,
  dropId,
  dropY,
  boxes,
  edges,
  fixedSide,
}: {
  edge: CanvasEdge;
  end: EdgeEnd;
  dropId: string | null;
  /** World y of the release, for which face a loop lands on. */
  dropY: number;
  boxes: Map<string, Box>;
  edges: CanvasEdge[];
  /** The side the fixed end leaves from today (from its route). */
  fixedSide: ConnectSide;
}): ReconnectPlan {
  if (!dropId) return { ok: false, why: "none" };
  const from = end === "source" ? dropId : edge.from;
  const to = end === "target" ? dropId : edge.to;
  if (from === edge.from && to === edge.to) return { ok: false, why: "same" };
  if (from === to) return { ok: false, why: "self" };
  if (edges.some((e) => e.id !== edge.id && e.from === from && e.to === to)) {
    return { ok: false, why: "duplicate" };
  }
  const source = boxes.get(from);
  const target = boxes.get(to);
  if (!source || !target) return { ok: false, why: "none" };

  const base = { from, to, bendX: null, bendY: null };
  if (!isBacktrack(source, target)) {
    return { ok: true, next: { ...base, kind: "flow", sourceSide: null, targetSide: null } };
  }
  if (end === "target") {
    const sides = deriveLoopSides(fixedSide, dropY, target);
    return { ok: true, next: { ...base, kind: "rework", ...sides } };
  }
  // The tail moved: it leaves from the face nearest the drop; the head keeps
  // the face it had (or matches the tail's).
  const sourceSide = half(dropY, source);
  const kept = fixedSide === "top" || fixedSide === "bottom" ? fixedSide : null;
  return {
    ok: true,
    next: { ...base, kind: "rework", sourceSide, targetSide: edge.targetSide ?? kept ?? sourceSide },
  };
}

const named = (name: string | undefined) => (name && name.trim()) || "Untitled step";

/** The change-log reason, e.g. "Reconnected: Review → Approve (was Review → File)". */
export function reconnectReason(
  names: Map<string, string>,
  before: Pick<EdgeEnds, "from" | "to">,
  after: Pick<EdgeEnds, "from" | "to">
): string {
  const n = (id: string) => named(names.get(id));
  return `Reconnected: ${n(after.from)} → ${n(after.to)} (was ${n(before.from)} → ${n(before.to)})`;
}

export const RECONNECT_MISS_MESSAGE: Partial<Record<ReconnectMiss, string>> = {
  duplicate: "Those steps are already connected.",
  self: "An arrow can't start and end on the same step.",
};
