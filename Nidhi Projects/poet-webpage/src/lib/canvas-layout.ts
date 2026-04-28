import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

import type { ProcessGraph } from "@/lib/types";

const NODE_SIZES: Record<string, { width: number; height: number }> = {
  event_start: { width: 50, height: 50 },
  event_end: { width: 50, height: 50 },
  event_intermediate: { width: 50, height: 50 },
  task: { width: 170, height: 64 },
  subprocess: { width: 170, height: 64 },
  gateway_exclusive: { width: 60, height: 60 },
  gateway_parallel: { width: 60, height: 60 },
  gateway_inclusive: { width: 60, height: 60 },
};

const FALLBACK_SIZE = NODE_SIZES.task;
const LANE_HEIGHT = 180;
const LANE_LABEL_WIDTH = 140;

export interface LaidOutGraph {
  nodes: Node[];
  edges: Edge[];
  width: number;
  height: number;
  laneOrder: { id: string; name: string; y: number }[];
}

/** Position graph nodes for ReactFlow.
 *
 * X comes from Dagre rank-based layout. Y is overridden so each node sits
 * inside its assigned lane band — gives BPMN swimlane semantics without
 * Dagre group/cluster support.
 */
export function layoutGraph(graph: ProcessGraph): LaidOutGraph {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 90, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of graph.nodes) {
    const size = NODE_SIZES[n.type] ?? FALLBACK_SIZE;
    g.setNode(n.id, { width: size.width, height: size.height });
  }
  for (const e of graph.edges) {
    g.setEdge(e.source_node_id, e.target_node_id);
  }
  dagre.layout(g);

  // Lanes in declared order; fallback bucket for any unassigned node
  const sortedLanes = [...graph.lanes].sort((a, b) => a.order_index - b.order_index);
  const laneOrderById = new Map(sortedLanes.map((l, idx) => [l.id, idx]));
  const laneOrder = sortedLanes.map((l, idx) => ({
    id: l.id,
    name: l.name,
    y: idx * LANE_HEIGHT,
  }));

  let maxX = 0;
  const nodes: Node[] = graph.nodes.map((n) => {
    const dPos = g.node(n.id);
    const size = NODE_SIZES[n.type] ?? FALLBACK_SIZE;
    const laneIdx = n.lane_id ? laneOrderById.get(n.lane_id) ?? 0 : 0;
    const laneCenterY = laneIdx * LANE_HEIGHT + LANE_HEIGHT / 2;
    const x = (dPos?.x ?? 0) - size.width / 2 + LANE_LABEL_WIDTH;
    const y = laneCenterY - size.height / 2;
    if (x + size.width > maxX) maxX = x + size.width;
    return {
      id: n.id,
      type: nodeKindFor(n.type),
      position: { x, y },
      data: { label: n.name, kind: n.type },
      draggable: true,
      selectable: true,
    };
  });

  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source_node_id,
    target: e.target_node_id,
    label: e.label || undefined,
    type: "smoothstep",
    animated: false,
    style: { strokeWidth: 1.5 },
  }));

  return {
    nodes,
    edges,
    width: maxX + 40,
    height: Math.max(LANE_HEIGHT, sortedLanes.length * LANE_HEIGHT),
    laneOrder,
  };
}

function nodeKindFor(type: string): string {
  if (type === "event_start" || type === "event_end" || type === "event_intermediate") {
    return "bpmnEvent";
  }
  if (type.startsWith("gateway_")) return "bpmnGateway";
  return "bpmnTask";
}

export const CANVAS_CONSTANTS = { LANE_HEIGHT, LANE_LABEL_WIDTH } as const;
