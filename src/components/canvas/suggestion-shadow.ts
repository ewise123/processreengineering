import type { CanvasNode, CanvasEdge, CanvasLane } from "./types";
import type { BundlePlan } from "./suggestion-apply";
import { placeNewNodeIn } from "./ai-edit";
import { sizeForNodeType } from "./node-type";
import { nodeKindFromType, LANE_PALETTE, LANE_HEIGHT, recomputeY } from "./layout";

export interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  lanes: CanvasLane[];
}

/** Apply a planned bundle to an in-memory copy of the canvas state, with NO API
 * calls. Mirrors the local-state effects of the canvas executor `runStep`, so
 * the preview matches a real Apply. Created objects use their step `tempId` as
 * the synthetic id (edges without one get `shadow:edge:<n>`), and refs resolve
 * through the same `tmp[ref] ?? ref` rule the executor uses. Pure. */
export function applyPlanToCanvas(state: CanvasState, plan: BundlePlan): CanvasState {
  let nodes: CanvasNode[] = state.nodes.map((n) => ({ ...n }));
  let edges: CanvasEdge[] = state.edges.map((e) => ({ ...e }));
  let lanes: CanvasLane[] = state.lanes.map((l) => ({ ...l }));

  const tmp: Record<string, string> = {};
  const resolve = (ref: string): string => tmp[ref] ?? ref;
  let synthEdge = 0;

  for (const step of plan.steps) {
    switch (step.kind) {
      case "update_node": {
        const id = resolve(step.nodeRef);
        nodes = nodes.map((n) => {
          if (n.id !== id) return n;
          const next = { ...n };
          if (step.name !== undefined) next.label = step.name;
          if (step.description !== undefined) next.description = step.description;
          if (step.laneRef !== undefined) next.laneId = resolve(step.laneRef);
          return next;
        });
        break;
      }
      case "delete_node": {
        const id = resolve(step.nodeRef);
        nodes = nodes.filter((n) => n.id !== id);
        edges = edges.filter((e) => e.from !== id && e.to !== id); // FK cascade
        break;
      }
      case "create_node": {
        const place = placeNewNodeIn(
          nodes,
          lanes,
          step.laneRef ? resolve(step.laneRef) : null,
          step.nearNodeRef ? resolve(step.nearNodeRef) : null
        );
        if (!place) break; // no lane to place into — drop (defensive)
        const size = sizeForNodeType(step.nodeType);
        nodes = [
          ...nodes,
          {
            id: step.tempId,
            type: step.nodeType,
            kind: nodeKindFromType(step.nodeType),
            label: step.label,
            laneId: place.laneId,
            x: place.x,
            relativeY: place.relativeY,
            w: size.w,
            h: size.h,
            aiProposed: true,
          },
        ];
        tmp[step.tempId] = step.tempId;
        break;
      }
      case "create_edge": {
        const id = step.tempId ?? `shadow:edge:${synthEdge++}`;
        if (step.tempId) tmp[step.tempId] = id;
        edges = [...edges, { id, from: resolve(step.fromRef), to: resolve(step.toRef), label: step.label }];
        break;
      }
      case "delete_edge": {
        edges = edges.filter((e) => e.id !== resolve(step.edgeRef));
        break;
      }
      case "update_edge_label": {
        const id = resolve(step.edgeRef);
        edges = edges.map((e) => (e.id === id ? { ...e, label: step.label } : e));
        break;
      }
      case "reroute_edge": {
        const id = resolve(step.edgeRef);
        const before = edges.find((e) => e.id === id);
        edges = edges.filter((e) => e.id !== id);
        edges = [
          ...edges,
          {
            id: `shadow:edge:${synthEdge++}`,
            from: step.fromRef ? resolve(step.fromRef) : before?.from ?? "",
            to: step.toRef ? resolve(step.toRef) : before?.to ?? "",
            label: before?.label ?? null,
          },
        ];
        break;
      }
      case "create_lane": {
        const slot = lanes.length;
        lanes = recomputeY([
          ...lanes,
          {
            id: step.tempId,
            label: step.name,
            color: LANE_PALETTE[slot % LANE_PALETTE.length],
            collapsed: false,
            y: 0,
            h: LANE_HEIGHT,
          },
        ]);
        tmp[step.tempId] = step.tempId;
        break;
      }
      case "update_lane": {
        const id = resolve(step.laneRef);
        lanes = lanes.map((l) => (l.id === id ? { ...l, label: step.name } : l));
        break;
      }
      default: {
        const _exhaustive: never = step;
        void _exhaustive;
      }
    }
  }

  return { nodes, edges, lanes };
}
