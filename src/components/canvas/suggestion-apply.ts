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
/** Build an O(n) lookup index from a ProcessGraph for planBundle's stale-ref checks. */
export function indexGraph(graph: ProcessGraph): GraphIndex {
  const laneNameToId = new Map<string, UUID>();
  for (const l of graph.lanes) laneNameToId.set(l.name, l.id);
  return {
    nodeIds: new Set(graph.nodes.map((n) => n.id)),
    edgeIds: new Set(graph.edges.map((e) => e.id)),
    laneIds: new Set(graph.lanes.map((l) => l.id)),
    laneNameToId,
  };
}

/** Every ref string a suggestion's op reads (consuming refs only — not temp_id). */
function consumedRefs(op: SuggestionOp): string[] {
  const refs: string[] = [];
  for (const v of [op.node_ref, op.edge_ref, op.lane_ref, op.from_ref, op.to_ref, op.near_node_ref]) {
    if (v) refs.push(v);
  }
  return refs;
}

/** Union-find: group suggestions joined by a shared `group` or a tmp_id dep. */
export function bundleSuggestions(suggestions: ChatSuggestion[]): Bundle[] {
  const parent = suggestions.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // 1) shared non-null group
  const byGroup = new Map<string, number>();
  suggestions.forEach((s, i) => {
    if (!s.group) return;
    if (byGroup.has(s.group)) union(byGroup.get(s.group)!, i);
    else byGroup.set(s.group, i);
  });

  // 2) tmp_id producer -> consumer
  const producerOf = new Map<string, number>();
  suggestions.forEach((s, i) => {
    if (s.op.temp_id) producerOf.set(s.op.temp_id, i);
  });
  suggestions.forEach((s, i) => {
    for (const ref of consumedRefs(s.op)) {
      const producer = producerOf.get(ref);
      if (producer !== undefined) union(producer, i);
    }
  });

  // Collect members per root, preserving document order.
  const groups = new Map<number, ChatSuggestion[]>();
  suggestions.forEach((s, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(s);
  });

  // Emit bundles in the document order of their first member.
  const roots = [...groups.keys()].sort((a, b) => a - b);
  return roots.map((root) => {
    const members = groups.get(root)!;
    return {
      id: members.map((m) => m.id).join("+"),
      suggestions: members,
      undoable: members.every((m) => !isDeleteOp(m.op.kind)),
    };
  });
}

/** Which id-set a given step field must exist in (for stale-ref checks). */
function stepRealRefs(step: MutationStep): { ref: string; set: "node" | "edge" | "lane" }[] {
  switch (step.kind) {
    case "update_node":
      return [
        { ref: step.nodeRef, set: "node" },
        ...(step.laneRef ? [{ ref: step.laneRef, set: "lane" as const }] : []),
      ];
    case "delete_node":
      return [{ ref: step.nodeRef, set: "node" }];
    case "create_node":
      return [
        ...(step.laneRef ? [{ ref: step.laneRef, set: "lane" as const }] : []),
        ...(step.nearNodeRef ? [{ ref: step.nearNodeRef, set: "node" as const }] : []),
      ];
    case "create_edge":
      return [
        { ref: step.fromRef, set: "node" },
        { ref: step.toRef, set: "node" },
      ];
    case "delete_edge":
      return [{ ref: step.edgeRef, set: "edge" }];
    case "update_edge_label":
      return [{ ref: step.edgeRef, set: "edge" }];
    case "reroute_edge":
      return [
        { ref: step.edgeRef, set: "edge" },
        ...(step.fromRef ? [{ ref: step.fromRef, set: "node" as const }] : []),
        ...(step.toRef ? [{ ref: step.toRef, set: "node" as const }] : []),
      ];
    case "update_lane":
      return [{ ref: step.laneRef, set: "lane" }];
    case "create_lane":
      return [];
    default: {
      const _exhaustive: never = step;
      void _exhaustive;
      return [];
    }
  }
}

const SET_BY_KIND: Record<"node" | "edge" | "lane", keyof Pick<GraphIndex, "nodeIds" | "edgeIds" | "laneIds">> = {
  node: "nodeIds",
  edge: "edgeIds",
  lane: "laneIds",
};

/** Order a bundle's suggestions so a tmp_id producer always precedes any
 * suggestion that consumes it. `bundleSuggestions` preserves document order,
 * and the backend usually emits producer-first — but we must not rely on it,
 * because the executor resolves tmp refs at run time as create-steps execute.
 * Stable DFS topological order; cycles (shouldn't happen) are broken safely. */
function orderByDependency(suggestions: ChatSuggestion[]): ChatSuggestion[] {
  const producerOf = new Map<string, ChatSuggestion>();
  for (const s of suggestions) if (s.op.temp_id) producerOf.set(s.op.temp_id, s);
  const out: ChatSuggestion[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();
  const visit = (s: ChatSuggestion) => {
    if (done.has(s.id) || onStack.has(s.id)) return; // skip finished / break cycles
    onStack.add(s.id);
    for (const ref of consumedRefs(s.op)) {
      const producer = producerOf.get(ref);
      if (producer && producer.id !== s.id) visit(producer);
    }
    onStack.delete(s.id);
    done.add(s.id);
    out.push(s);
  };
  for (const s of suggestions) visit(s);
  return out;
}

/** Build an ordered, validated plan for one bundle. Suggestions are reordered so
 * tmp producers precede consumers; a tmp ref produced ANYWHERE in the plan counts
 * as in-plan (order-independent), and every other ref must exist in the current
 * graph index, else the bundle is marked unapplyable. */
export function planBundle(bundle: Bundle, index: GraphIndex): BundlePlan {
  const steps = orderByDependency(bundle.suggestions).flatMap((s) => opToSteps(s.op));
  // Every tmp produced anywhere in this plan — validation is order-independent.
  const producedAll = new Set<string>();
  for (const step of steps) {
    if ("tempId" in step && step.tempId) producedAll.add(step.tempId);
  }
  let applyable = true;
  let reason: string | undefined;

  // A consumed tmp whose producer is absent is caught here by the same check as
  // a missing real ref: it's neither in `producedAll` nor in the graph index.
  for (const step of steps) {
    for (const { ref, set } of stepRealRefs(step)) {
      if (producedAll.has(ref)) continue; // created within this plan
      if (!index[SET_BY_KIND[set]].has(ref)) {
        applyable = false;
        reason = `A referenced ${set} no longer exists on the map.`;
        break;
      }
    }
    if (!applyable) break;
  }

  return { bundleId: bundle.id, steps, undoable: bundle.undoable, applyable, reason };
}
