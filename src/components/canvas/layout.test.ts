import { describe, expect, it } from "vitest";

import { buildCanvasState } from "./layout";
import type { ProcessGraph } from "@/lib/types";

function graphWith(props: Record<string, unknown>): ProcessGraph {
  return {
    version: { id: "v", model_id: "m", version_number: 1, status: "draft" } as never,
    lanes: [
      { id: "L", name: "Ops", order_index: 0, height_px: 200, collapsed: false } as never,
    ],
    nodes: [
      {
        id: "N",
        type: "task",
        name: "Step",
        lane_id: "L",
        position: { x: 10, relative_y: 5 },
        properties: props,
      } as never,
    ],
    edges: [],
  };
}

describe("buildCanvasState ai_proposed + description", () => {
  it("maps properties.ai_proposed and properties.description onto the node", () => {
    const { nodes } = buildCanvasState(
      graphWith({ ai_proposed: true, description: "does a thing" })
    );
    expect(nodes[0].aiProposed).toBe(true);
    expect(nodes[0].description).toBe("does a thing");
  });

  it("defaults aiProposed to false and description to undefined", () => {
    const { nodes } = buildCanvasState(graphWith({}));
    expect(nodes[0].aiProposed).toBe(false);
    expect(nodes[0].description).toBeUndefined();
  });
});

describe("buildCanvasState evidence_stale", () => {
  it("maps properties.evidence_stale onto the node", () => {
    const { nodes } = buildCanvasState(graphWith({ evidence_stale: true }));
    expect(nodes[0].evidenceStale).toBe(true);
  });

  it("defaults evidenceStale to false when absent", () => {
    const { nodes } = buildCanvasState(graphWith({}));
    expect(nodes[0].evidenceStale).toBe(false);
  });
});

function graphWithEdge(condition_text: string | null): ProcessGraph {
  return {
    version: { id: "v", model_id: "m", version_number: 1, status: "draft" } as never,
    lanes: [
      { id: "L", name: "Ops", order_index: 0, height_px: 200, collapsed: false } as never,
    ],
    nodes: [
      { id: "N1", type: "task", name: "Step 1", lane_id: "L", position: {}, properties: {} } as never,
      { id: "N2", type: "task", name: "Step 2", lane_id: "L", position: {}, properties: {} } as never,
    ],
    edges: [
      {
        id: "E",
        source_node_id: "N1",
        target_node_id: "N2",
        label: null,
        condition_text,
      } as never,
    ],
  };
}

describe("buildCanvasState condition_text", () => {
  it("maps edge condition_text onto the edge's condition", () => {
    const { edges } = buildCanvasState(graphWithEdge("amount > 1000"));
    expect(edges[0].condition).toBe("amount > 1000");
  });

  it("defaults condition to null when condition_text is absent", () => {
    const { edges } = buildCanvasState(graphWithEdge(null));
    expect(edges[0].condition).toBeNull();
  });
});
