import type { UUID } from "@/lib/types";

interface FocusNode {
  id: UUID;
  laneId: UUID | null;
  x: number;
  relativeY: number;
  w: number;
  h: number;
}
interface FocusLane {
  id: UUID;
  y: number;
}

/** World-space center of the midpoint between an edge's two endpoint nodes,
 * or null if either endpoint is missing. Mirrors the canvas convention that a
 * node's absolute Y is its lane's y plus relativeY. */
export function edgeFocusCenter(
  edge: { from: UUID; to: UUID },
  nodes: FocusNode[],
  lanes: FocusLane[]
): { cx: number; cy: number } | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return null;
  const laneY = (n: FocusNode) =>
    (n.laneId ? lanes.find((l) => l.id === n.laneId)?.y ?? 0 : 0) + n.relativeY;
  const centerOf = (n: FocusNode) => ({ x: n.x + n.w / 2, y: laneY(n) + n.h / 2 });
  const ca = centerOf(a);
  const cb = centerOf(b);
  return { cx: (ca.x + cb.x) / 2, cy: (ca.y + cb.y) / 2 };
}
