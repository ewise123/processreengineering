/**
 * Whole-map connector layout: decide where every connector attaches, then
 * route it. Done for all edges at once because a good attachment depends on
 * the neighbours — two connectors on one side of a step should sit apart, a
 * gateway's branches should leave from different corners, and a pair of
 * edges running A→B and B→A should not draw on top of each other.
 *
 * No obstacle avoidance: routes can still cross other steps. That is a
 * deliberate scope line (issue #95); attachment is what fixes the stacking
 * and double-headed-arrow look.
 *
 * Pure: no React, no DOM.
 */

import {
  buildEdgePath,
  type ConnectSide,
  type EdgePath,
  type SimpleRect,
} from "./edge-path";
import { pointAlong, polylineLength, type Pt } from "./rounded-path";
import type { CanvasEdge, CanvasNodeKind } from "./types";

export interface RoutableNode extends SimpleRect {
  id: string;
  kind: CanvasNodeKind;
}

export interface EdgeRoute extends EdgePath {
  sourceSide: ConnectSide;
  targetSide: ConnectSide;
  /** Where the edge's label pill is centred. */
  labelAt: Pt;
}

type RoutableEdge = Pick<
  CanvasEdge,
  "id" | "from" | "to" | "bendX" | "bendY" | "sourceSide" | "targetSide"
>;

const SIDES: ConnectSide[] = ["top", "right", "bottom", "left"];

/** Max spacing between connectors sharing one side. */
const PORT_GAP = 16;
/** Fraction of a side that spread connectors may occupy. */
const PORT_SPAN = 0.6;
/** How far along a gateway branch its label sits. */
const BRANCH_LABEL_DISTANCE = 30;

const NORMAL: Record<ConnectSide, Pt> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

const center = (r: SimpleRect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

function isRound(kind: CanvasNodeKind): boolean {
  return kind === "start" || kind === "end" || kind === "intermediate";
}

/** Which face of `r` a route endpoint lies on. */
export function sideOf(r: SimpleRect, p: Pt): ConnectSide {
  const d: Record<ConnectSide, number> = {
    top: Math.abs(p.y - r.y),
    bottom: Math.abs(p.y - (r.y + r.h)),
    left: Math.abs(p.x - r.x),
    right: Math.abs(p.x - (r.x + r.w)),
  };
  return SIDES.reduce((best, s) => (d[s] < d[best] ? s : best), "top" as ConnectSide);
}

function pinned(e: RoutableEdge): boolean {
  return !!e.sourceSide && !!e.targetSide;
}

function hasBend(e: RoutableEdge): boolean {
  return typeof e.bendX === "number" || typeof e.bendY === "number";
}

function permutations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest, k - 1)) out.push([item, ...tail]);
  });
  return out;
}

/**
 * Give each outgoing branch of a gateway its own corner. Corners already used
 * by incoming connectors are kept free. Among the remaining assignments, pick
 * the one whose corners best face their targets (sum of direction cosines).
 * A diamond has four corners, so this is at most 4! candidates.
 */
function assignGatewayExits(
  gateway: RoutableNode,
  outgoing: { edge: RoutableEdge; target: RoutableNode }[],
  incomingSides: Set<ConnectSide>
): Map<string, ConnectSide> {
  const result = new Map<string, ConnectSide>();
  let free = SIDES.filter((s) => !incomingSides.has(s));
  if (free.length < outgoing.length) free = [...SIDES];
  const k = Math.min(outgoing.length, free.length);
  const gc = center(gateway);
  const score = (side: ConnectSide, target: RoutableNode) => {
    const tc = center(target);
    const v = { x: tc.x - gc.x, y: tc.y - gc.y };
    const len = Math.hypot(v.x, v.y) || 1;
    return (NORMAL[side].x * v.x + NORMAL[side].y * v.y) / len;
  };
  let best: ConnectSide[] | null = null;
  let bestScore = -Infinity;
  for (const perm of permutations(free, k)) {
    const s = perm.reduce((acc, side, i) => acc + score(side, outgoing[i].target), 0);
    if (s > bestScore + 1e-9) {
      bestScore = s;
      best = perm;
    }
  }
  best?.forEach((side, i) => result.set(outgoing[i].edge.id, side));
  return result;
}

/** Route every edge whose two ends are both in `nodes`. */
export function computeEdgeRoutes(
  edges: RoutableEdge[],
  nodes: RoutableNode[]
): Map<string, EdgeRoute> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const live = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);

  // Pass 1: nominal routes, used to learn which sides edges naturally use.
  const nominal = new Map<string, EdgePath>();
  for (const e of live) {
    nominal.set(e.id, buildEdgePath(byId.get(e.from)!, byId.get(e.to)!, {
      bendX: e.bendX,
      bendY: e.bendY,
      sourceSide: e.sourceSide,
      targetSide: e.targetSide,
    }));
  }

  // Pass 2: gateway branches leave from distinct corners.
  const exits = new Map<string, ConnectSide>();
  for (const g of nodes) {
    if (g.kind !== "gateway") continue;
    const outgoing = live
      .filter((e) => e.from === g.id && !pinned(e) && !hasBend(e))
      .map((edge) => ({ edge, target: byId.get(edge.to)! }))
      .sort((a, b) => (a.edge.id < b.edge.id ? -1 : 1));
    if (outgoing.length < 2) continue;
    const incomingSides = new Set<ConnectSide>();
    for (const e of live) {
      if (e.to !== g.id) continue;
      const pts = nominal.get(e.id)!.points;
      incomingSides.add(sideOf(g, pts[pts.length - 1]));
    }
    for (const [id, side] of assignGatewayExits(g, outgoing, incomingSides)) exits.set(id, side);
  }

  const routeWith = (e: RoutableEdge, sOff: number, tOff: number) =>
    buildEdgePath(byId.get(e.from)!, byId.get(e.to)!, {
      bendX: e.bendX,
      bendY: e.bendY,
      sourceSide: e.sourceSide,
      targetSide: e.targetSide,
      sourceExit: exits.get(e.id) ?? null,
      sourceOffset: sOff,
      targetOffset: tOff,
    });

  // Pass 3: collect attachments per (node, side). Diamonds and circles attach
  // at fixed points, so only rectangular steps get spread.
  type Attach = { edgeId: string; end: "s" | "t"; key: number };
  const groups = new Map<string, Attach[]>();
  const firstPass = new Map<string, EdgePath>();
  for (const e of live) {
    const r = routeWith(e, 0, 0);
    firstPass.set(e.id, r);
    const ends: ["s" | "t", RoutableNode, Pt, RoutableNode][] = [
      ["s", byId.get(e.from)!, r.points[0], byId.get(e.to)!],
      ["t", byId.get(e.to)!, r.points[r.points.length - 1], byId.get(e.from)!],
    ];
    for (const [end, node, pt, other] of ends) {
      if (node.kind === "gateway" || isRound(node.kind)) continue;
      const side = sideOf(node, pt);
      const oc = center(other);
      const key = side === "top" || side === "bottom" ? oc.x : oc.y;
      const gk = `${node.id}:${side}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk)!.push({ edgeId: e.id, end, key });
    }
  }

  const offsets = new Map<string, { s: number; t: number }>();
  for (const [gk, list] of groups) {
    if (list.length < 2) continue;
    const [nodeId, side] = gk.split(":") as [string, ConnectSide];
    const node = byId.get(nodeId)!;
    const sideLen = side === "top" || side === "bottom" ? node.w : node.h;
    const gap = Math.min(PORT_GAP, (sideLen * PORT_SPAN) / (list.length - 1));
    list.sort((a, b) => a.key - b.key || (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0));
    list.forEach((a, i) => {
      const off = (i - (list.length - 1) / 2) * gap;
      const cur = offsets.get(a.edgeId) ?? { s: 0, t: 0 };
      if (a.end === "s") cur.s = off;
      else cur.t = off;
      offsets.set(a.edgeId, cur);
    });
  }

  // Pass 4: final routes.
  const routes = new Map<string, EdgeRoute>();
  for (const e of live) {
    const off = offsets.get(e.id);
    const r = off ? routeWith(e, off.s, off.t) : firstPass.get(e.id)!;
    const from = byId.get(e.from)!;
    const to = byId.get(e.to)!;
    const len = polylineLength(r.points);
    const labelAt =
      from.kind === "gateway"
        ? pointAlong(r.points, Math.min(BRANCH_LABEL_DISTANCE, len * 0.4))
        : pointAlong(r.points, len / 2);
    routes.set(e.id, {
      ...r,
      sourceSide: sideOf(from, r.points[0]),
      targetSide: sideOf(to, r.points[r.points.length - 1]),
      labelAt,
    });
  }
  return routes;
}
