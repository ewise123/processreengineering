import type { ChatSuggestion, OpKind, SuggestionOp, UUID, ProcessGraph } from "@/lib/types";

/** Op kinds that delete or re-point objects. A bundle containing any of these
 * is non-undoable and requires a confirm before applying. */
const DELETE_OPS = new Set<OpKind>(["remove_node", "remove_edge", "reroute_edge"]);

export function isDeleteOp(kind: OpKind): boolean {
  return DELETE_OPS.has(kind);
}

/** A single executable mutation. Ref fields hold either a real UUID or a
 * tmp placeholder (a producing step's `tempId`); the executor resolves them. */
export type MutationStep =
  | { kind: "update_node"; nodeRef: string; name?: string; description?: string; laneRef?: string }
  | { kind: "delete_node"; nodeRef: string }
  | { kind: "create_node"; tempId: string; laneRef: string | null; nodeType: string; label: string; nearNodeRef: string | null; role?: string | null }
  | { kind: "create_edge"; tempId?: string; fromRef: string; toRef: string; label: string | null }
  | { kind: "delete_edge"; edgeRef: string }
  | { kind: "update_edge_label"; edgeRef: string; label: string }
  | { kind: "reroute_edge"; edgeRef: string; fromRef: string | null; toRef: string | null }
  | { kind: "create_lane"; tempId: string; name: string }
  | { kind: "update_lane"; laneRef: string; name: string };

/** Translate one op into its ordered mutation steps. Pure; no ref resolution. */
export function opToSteps(op: SuggestionOp): MutationStep[] {
  switch (op.kind) {
    case "relabel_node":
      return [{ kind: "update_node", nodeRef: op.node_ref!, name: op.new_label! }];
    case "describe_node":
      return [{ kind: "update_node", nodeRef: op.node_ref!, description: op.description! }];
    case "move_to_lane":
      return [{ kind: "update_node", nodeRef: op.node_ref!, laneRef: op.lane_ref! }];
    case "remove_node":
      return [{ kind: "delete_node", nodeRef: op.node_ref! }];
    case "add_edge":
      return [{ kind: "create_edge", fromRef: op.from_ref!, toRef: op.to_ref!, label: op.edge_label ?? null }];
    case "remove_edge":
      return [{ kind: "delete_edge", edgeRef: op.edge_ref! }];
    case "relabel_edge":
      return [{ kind: "update_edge_label", edgeRef: op.edge_ref!, label: op.new_label! }];
    case "reroute_edge":
      return [{ kind: "reroute_edge", edgeRef: op.edge_ref!, fromRef: op.from_ref ?? null, toRef: op.to_ref ?? null }];
    case "add_node":
      return [
        {
          kind: "create_node",
          tempId: op.temp_id!,
          laneRef: op.lane_ref ?? null,
          nodeType: op.node_type!,
          label: op.new_label!,
          nearNodeRef: op.near_node_ref ?? null,
        },
      ];
    case "add_lane":
      return [{ kind: "create_lane", tempId: op.temp_id!, name: op.name! }];
    case "rename_lane":
      return [{ kind: "update_lane", laneRef: op.lane_ref!, name: op.name! }];
    case "decompose": {
      const steps: MutationStep[] = [];
      const subs = op.sub_steps ?? [];
      let prevRef = op.node_ref!;
      subs.forEach((s, i) => {
        const tempId = `${op.node_ref}::sub${i}`;
        steps.push({
          kind: "create_node",
          tempId,
          laneRef: null,
          nodeType: s.proposed_type ?? "task",
          label: s.proposed_name,
          nearNodeRef: prevRef,
          role: s.role ?? null,
        });
        steps.push({ kind: "create_edge", fromRef: prevRef, toRef: tempId, label: s.edge_label ?? null });
        prevRef = tempId;
      });
      return steps;
    }
    default: {
      const _exhaustive: never = op.kind;
      void _exhaustive;
      return [];
    }
  }
}

// Placeholder exports completed in later tasks:
export interface GraphIndex {
  nodeIds: Set<UUID>;
  edgeIds: Set<UUID>;
  laneIds: Set<UUID>;
  laneNameToId: Map<string, UUID>;
}
export interface Bundle {
  id: string;
  suggestions: ChatSuggestion[];
  undoable: boolean;
}
export interface BundlePlan {
  bundleId: string;
  steps: MutationStep[];
  undoable: boolean;
  applyable: boolean;
  reason?: string;
}
export interface BatchResult {
  ok: boolean;
  error?: string;
  undo?: () => Promise<void>;
}
// indexGraph / bundleSuggestions / planBundle implemented in Tasks 2 & 3.
export function indexGraph(_graph: ProcessGraph): GraphIndex {
  throw new Error("not implemented");
}
