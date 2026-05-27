import dagre from "@dagrejs/dagre";

import type { ProcessGraph } from "@/lib/types";
import type { CanvasEdge, CanvasLane, CanvasNode, CanvasNodeKind } from "./types";

const NODE_SIZES: Record<CanvasNodeKind, { w: number; h: number }> = {
  start: { w: 50, h: 50 },
  end: { w: 50, h: 50 },
  intermediate: { w: 50, h: 50 },
  gateway: { w: 60, h: 60 },
  task: { w: 170, h: 64 },
  subprocess: { w: 170, h: 64 },
  user: { w: 170, h: 64 },
  service: { w: 170, h: 64 },
  manual: { w: 170, h: 64 },
  send: { w: 170, h: 64 },
  receive: { w: 170, h: 64 },
};

const LANE_PALETTE = [
  "#dbeafe", // blue
  "#dcfce7", // green
  "#fef9c3", // yellow
  "#fae8ff", // purple
  "#fce7f3", // pink
  "#cffafe", // cyan
  "#ffedd5", // orange
  "#e0e7ff", // indigo
];

export const LANE_HEIGHT = 150;
const LANE_PADDING_LEFT = 110; // gap between lane header strip and first node

function nodeKindFromType(type: string): CanvasNodeKind {
  switch (type) {
    case "event_start":
      return "start";
    case "event_end":
      return "end";
    case "event_intermediate":
      return "intermediate";
    case "task":
      return "task";
    case "subprocess":
      return "subprocess";
    case "gateway_exclusive":
    case "gateway_parallel":
    case "gateway_inclusive":
      return "gateway";
    default:
      return "task";
  }
}

export function buildCanvasState(graph: ProcessGraph): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  lanes: CanvasLane[];
} {
  const sortedLanes = [...graph.lanes].sort(
    (a, b) => a.order_index - b.order_index
  );
  const laneIndexById = new Map(sortedLanes.map((l, i) => [l.id, i]));

  // Compute Y positions cumulatively from each lane's height_px (defaulting
  // to LANE_HEIGHT when older data has no stored height).
  const lanes: CanvasLane[] = [];
  const laneHeightById = new Map<string, number>();
  let runningY = 0;
  for (let i = 0; i < sortedLanes.length; i++) {
    const l = sortedLanes[i];
    const h = l.height_px ?? LANE_HEIGHT;
    lanes.push({
      id: l.id,
      label: l.name,
      color: LANE_PALETTE[i % LANE_PALETTE.length],
      y: runningY,
      h,
    });
    laneHeightById.set(l.id, h);
    runningY += h;
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    nodesep: 60,
    ranksep: 90,
    marginx: LANE_PADDING_LEFT,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) {
    const kind = nodeKindFromType(n.type);
    const size = NODE_SIZES[kind];
    g.setNode(n.id, { width: size.w, height: size.h });
  }
  for (const e of graph.edges) {
    g.setEdge(e.source_node_id, e.target_node_id);
  }
  dagre.layout(g);

  // Prefer persisted positions from the server (`position.x` / `position.relative_y`);
  // fall back to Dagre + lane-center for nodes that haven't been moved yet.
  const nodes: CanvasNode[] = graph.nodes.map((n) => {
    const kind = nodeKindFromType(n.type);
    const size = NODE_SIZES[kind];
    const dPos = g.node(n.id);
    const persisted = (n.position ?? {}) as { x?: number; relative_y?: number };
    const x =
      typeof persisted.x === "number"
        ? persisted.x
        : Math.max(LANE_PADDING_LEFT, (dPos?.x ?? 0) - size.w / 2);
    const fallbackLaneHeight =
      (n.lane_id ? laneHeightById.get(n.lane_id) : undefined) ?? LANE_HEIGHT;
    const relativeY =
      typeof persisted.relative_y === "number"
        ? persisted.relative_y
        : fallbackLaneHeight / 2 - size.h / 2;
    return {
      id: n.id,
      kind,
      label: n.name,
      laneId: n.lane_id,
      x,
      relativeY,
      w: size.w,
      h: size.h,
    };
  });

  const edges: CanvasEdge[] = graph.edges.map((e) => ({
    id: e.id,
    from: e.source_node_id,
    to: e.target_node_id,
    label: e.label,
    bendX: e.bend_x ?? null,
    bendY: e.bend_y ?? null,
  }));

  return { nodes, edges, lanes };
}
