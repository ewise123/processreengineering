import { describe, it, expect } from "vitest";
import { opToSteps, isDeleteOp, bundleSuggestions, indexGraph, planBundle, reasonForSuggestion } from "./suggestion-apply";
import type { SuggestionOp, ChatSuggestion, ProcessGraph } from "@/lib/types";
import type { GraphIndex } from "./suggestion-apply";

const op = (o: Partial<SuggestionOp> & { kind: SuggestionOp["kind"] }): SuggestionOp => ({
  kind: o.kind,
  node_ref: o.node_ref ?? null,
  edge_ref: o.edge_ref ?? null,
  lane_ref: o.lane_ref ?? null,
  temp_id: o.temp_id ?? null,
  from_ref: o.from_ref ?? null,
  to_ref: o.to_ref ?? null,
  new_label: o.new_label ?? null,
  description: o.description ?? null,
  name: o.name ?? null,
  node_type: o.node_type ?? null,
  near_node_ref: o.near_node_ref ?? null,
  edge_label: o.edge_label ?? null,
  sub_steps: o.sub_steps ?? null,
});

describe("isDeleteOp", () => {
  it("flags remove_node, remove_edge, reroute_edge as delete-containing", () => {
    expect(isDeleteOp("remove_node")).toBe(true);
    expect(isDeleteOp("remove_edge")).toBe(true);
    expect(isDeleteOp("reroute_edge")).toBe(true);
  });
  it("treats edits/creates as non-delete", () => {
    expect(isDeleteOp("relabel_node")).toBe(false);
    expect(isDeleteOp("add_edge")).toBe(false);
    expect(isDeleteOp("decompose")).toBe(false);
  });
});

describe("opToSteps", () => {
  it("maps relabel_node to an update_node name step", () => {
    expect(opToSteps(op({ kind: "relabel_node", node_ref: "N1", new_label: "Review" }))).toEqual([
      { kind: "update_node", nodeRef: "N1", name: "Review" },
    ]);
  });
  it("maps move_to_lane to update_node laneRef", () => {
    expect(opToSteps(op({ kind: "move_to_lane", node_ref: "N1", lane_ref: "L2" }))).toEqual([
      { kind: "update_node", nodeRef: "N1", laneRef: "L2" },
    ]);
  });
  it("maps add_node to create_node carrying its temp_id", () => {
    expect(
      opToSteps(op({ kind: "add_node", temp_id: "t1", lane_ref: "L1", node_type: "task", new_label: "Approve", near_node_ref: "N3" }))
    ).toEqual([
      { kind: "create_node", tempId: "t1", laneRef: "L1", nodeType: "task", label: "Approve", nearNodeRef: "N3" },
    ]);
  });
  it("maps add_edge to create_edge with optional label", () => {
    expect(opToSteps(op({ kind: "add_edge", from_ref: "N1", to_ref: "t1", edge_label: "yes" }))).toEqual([
      { kind: "create_edge", fromRef: "N1", toRef: "t1", label: "yes" },
    ]);
  });
  it("maps reroute_edge to a single reroute_edge step", () => {
    expect(opToSteps(op({ kind: "reroute_edge", edge_ref: "E1", to_ref: "N9" }))).toEqual([
      { kind: "reroute_edge", edgeRef: "E1", fromRef: null, toRef: "N9" },
    ]);
  });
  it("expands decompose into chained create_node + create_edge steps", () => {
    const steps = opToSteps(
      op({
        kind: "decompose",
        node_ref: "N1",
        sub_steps: [
          { proposed_name: "A", proposed_type: "task", role: null, edge_label: "start" },
          { proposed_name: "B", proposed_type: "task", role: null, edge_label: null },
        ],
      })
    );
    expect(steps).toEqual([
      { kind: "create_node", tempId: "N1::sub0", laneRef: null, nodeType: "task", label: "A", nearNodeRef: "N1", role: null },
      { kind: "create_edge", fromRef: "N1", toRef: "N1::sub0", label: "start" },
      { kind: "create_node", tempId: "N1::sub1", laneRef: null, nodeType: "task", label: "B", nearNodeRef: "N1::sub0", role: null },
      { kind: "create_edge", fromRef: "N1::sub0", toRef: "N1::sub1", label: null },
    ]);
  });
  it("maps describe_node to an update_node description step", () => {
    expect(opToSteps(op({ kind: "describe_node", node_ref: "N1", description: "Handles intake" }))).toEqual([
      { kind: "update_node", nodeRef: "N1", description: "Handles intake" },
    ]);
  });
  it("maps remove_node to a delete_node step", () => {
    expect(opToSteps(op({ kind: "remove_node", node_ref: "N1" }))).toEqual([
      { kind: "delete_node", nodeRef: "N1" },
    ]);
  });
  it("maps remove_edge to a delete_edge step", () => {
    expect(opToSteps(op({ kind: "remove_edge", edge_ref: "E1" }))).toEqual([
      { kind: "delete_edge", edgeRef: "E1" },
    ]);
  });
  it("maps relabel_edge to an update_edge_label step", () => {
    expect(opToSteps(op({ kind: "relabel_edge", edge_ref: "E1", new_label: "rejected" }))).toEqual([
      { kind: "update_edge_label", edgeRef: "E1", label: "rejected" },
    ]);
  });
  it("maps add_lane to a create_lane step carrying its temp_id", () => {
    expect(opToSteps(op({ kind: "add_lane", temp_id: "tL1", name: "Finance" }))).toEqual([
      { kind: "create_lane", tempId: "tL1", name: "Finance" },
    ]);
  });
  it("maps rename_lane to an update_lane step", () => {
    expect(opToSteps(op({ kind: "rename_lane", lane_ref: "L1", name: "Operations" }))).toEqual([
      { kind: "update_lane", laneRef: "L1", name: "Operations" },
    ]);
  });
});

describe("new op kinds → steps", () => {
  it("change_node_type → update_node with nodeType", () => {
    expect(opToSteps({ kind: "change_node_type", node_ref: "N1", node_type: "gateway_exclusive" }))
      .toEqual([{ kind: "update_node", nodeRef: "N1", nodeType: "gateway_exclusive" }]);
  });
  it("remove_lane → delete_lane", () => {
    expect(opToSteps({ kind: "remove_lane", lane_ref: "L1" })).toEqual([{ kind: "delete_lane", laneRef: "L1" }]);
  });
  it("set_edge_condition → update_edge_condition", () => {
    expect(opToSteps({ kind: "set_edge_condition", edge_ref: "E1", condition_text: "amt > 10000" }))
      .toEqual([{ kind: "update_edge_condition", edgeRef: "E1", conditionText: "amt > 10000" }]);
  });
  it("remove_lane is a delete op", () => {
    expect(isDeleteOp("remove_lane")).toBe(true);
  });
});

const sg = (id: string, opOverrides: Partial<SuggestionOp> & { kind: SuggestionOp["kind"] }, group?: string): ChatSuggestion => ({
  id,
  group: group ?? null,
  title: id,
  op: op(opOverrides),
  affected_refs: [],
  rationale: "",
  cited_claim_ids: [],
});

describe("bundleSuggestions", () => {
  it("keeps independent suggestions as singleton bundles", () => {
    const a = sg("a", { kind: "relabel_node", node_ref: "N1", new_label: "X" });
    const b = sg("b", { kind: "relabel_node", node_ref: "N2", new_label: "Y" });
    const bundles = bundleSuggestions([a, b]);
    expect(bundles.map((x) => x.suggestions.map((s) => s.id))).toEqual([["a"], ["b"]]);
  });
  it("bundles suggestions that share a non-null group", () => {
    const a = sg("a", { kind: "relabel_node", node_ref: "N1", new_label: "X" }, "g1");
    const b = sg("b", { kind: "relabel_node", node_ref: "N2", new_label: "Y" }, "g1");
    const bundles = bundleSuggestions([a, b]);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].suggestions.map((s) => s.id)).toEqual(["a", "b"]);
  });
  it("bundles a tmp_id producer with its consumer", () => {
    const a = sg("a", { kind: "add_node", temp_id: "t1", lane_ref: "L1", node_type: "task", new_label: "New" });
    const b = sg("b", { kind: "add_edge", from_ref: "N1", to_ref: "t1" });
    const bundles = bundleSuggestions([a, b]);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].suggestions.map((s) => s.id)).toEqual(["a", "b"]);
  });
  it("marks a bundle non-undoable if any member is a delete op", () => {
    const a = sg("a", { kind: "remove_node", node_ref: "N1" }, "g1");
    const b = sg("b", { kind: "relabel_node", node_ref: "N2", new_label: "Y" }, "g1");
    const bundles = bundleSuggestions([a, b]);
    expect(bundles[0].undoable).toBe(false);
  });
});

describe("indexGraph", () => {
  it("indexes node/edge/lane ids and lane names", () => {
    const graph = {
      nodes: [{ id: "n1" }, { id: "n2" }],
      edges: [{ id: "e1" }],
      lanes: [{ id: "l1", name: "Ops" }],
    } as unknown as ProcessGraph;
    const idx = indexGraph(graph);
    expect(idx.nodeIds.has("n1")).toBe(true);
    expect(idx.edgeIds.has("e1")).toBe(true);
    expect(idx.laneNameToId.get("Ops")).toBe("l1");
  });
});

const idx = (over?: Partial<GraphIndex>): GraphIndex => ({
  nodeIds: new Set(["N1", "N2"]),
  edgeIds: new Set(["E1"]),
  laneIds: new Set(["L1"]),
  laneNameToId: new Map(),
  ...over,
});

describe("planBundle", () => {
  it("produces ordered steps for a tmp-linked bundle and stays applyable", () => {
    const bundle = bundleSuggestions([
      sg("a", { kind: "add_node", temp_id: "t1", lane_ref: "L1", node_type: "task", new_label: "New" }),
      sg("b", { kind: "add_edge", from_ref: "N1", to_ref: "t1" }),
    ])[0];
    const plan = planBundle(bundle, idx());
    expect(plan.applyable).toBe(true);
    expect(plan.undoable).toBe(true);
    expect(plan.steps.map((s) => s.kind)).toEqual(["create_node", "create_edge"]);
  });
  it("reorders so a tmp producer precedes its consumer even when emitted consumer-first", () => {
    // Backend emits the add_edge (consumer of t1) BEFORE the add_node (producer).
    const bundle = bundleSuggestions([
      sg("b", { kind: "add_edge", from_ref: "N1", to_ref: "t1" }),
      sg("a", { kind: "add_node", temp_id: "t1", lane_ref: "L1", node_type: "task", new_label: "New" }),
    ])[0];
    const plan = planBundle(bundle, idx());
    expect(plan.applyable).toBe(true);
    expect(plan.steps.map((s) => s.kind)).toEqual(["create_node", "create_edge"]);
    // Identity assertions: a wrong-object reorder (kinds right but steps swapped)
    // must not pass — the producer step must own t1 and the consumer must point at it.
    const [n, e] = plan.steps;
    if (n.kind !== "create_node") throw new Error("expected first step to be create_node");
    expect(n.tempId).toBe("t1");
    if (e.kind !== "create_edge") throw new Error("expected second step to be create_edge");
    expect(e.toRef).toBe("t1");
  });
  it("marks a bundle unapplyable when a real ref no longer exists", () => {
    const bundle = bundleSuggestions([sg("a", { kind: "relabel_node", node_ref: "GONE", new_label: "X" })])[0];
    const plan = planBundle(bundle, idx());
    expect(plan.applyable).toBe(false);
    expect(plan.reason).toMatch(/not on the current map/i);
  });
  it("marks a bundle unapplyable when a consumed tmp is never produced", () => {
    // "ghost" is neither produced in-plan nor a real graph ref, so it trips the
    // same stale-ref check as a missing real ref (identical code path + reason).
    const bundle = bundleSuggestions([sg("a", { kind: "add_edge", from_ref: "N1", to_ref: "ghost" })])[0];
    const plan = planBundle(bundle, idx());
    expect(plan.applyable).toBe(false);
    expect(plan.reason).toMatch(/not on the current map/i);
  });
  it("classifies a delete bundle as non-undoable but applyable", () => {
    const bundle = bundleSuggestions([sg("a", { kind: "remove_edge", edge_ref: "E1" })])[0];
    const plan = planBundle(bundle, idx());
    expect(plan.applyable).toBe(true);
    expect(plan.undoable).toBe(false);
  });
  it("resolves a decompose sub-step role to a lane id when the role matches an existing lane name", () => {
    const bundle = bundleSuggestions([
      sg("a", {
        kind: "decompose",
        node_ref: "N1",
        sub_steps: [{ proposed_name: "Approve Invoice", proposed_type: "task", role: "Finance", edge_label: null }],
      }),
    ])[0];
    const index = idx({ laneIds: new Set(["L1", "L9"]), laneNameToId: new Map([["Finance", "L9"]]) });
    const plan = planBundle(bundle, index);
    expect(plan.applyable).toBe(true);
    const createStep = plan.steps.find((s) => s.kind === "create_node");
    if (!createStep || createStep.kind !== "create_node") throw new Error("Expected a create_node step");
    expect(createStep.laneRef).toBe("L9");
  });
  it("leaves laneRef null when the decompose sub-step role does not match any lane name", () => {
    const bundle = bundleSuggestions([
      sg("a", {
        kind: "decompose",
        node_ref: "N1",
        sub_steps: [{ proposed_name: "Unknown Lane Step", proposed_type: "task", role: "NoSuchLane", edge_label: null }],
      }),
    ])[0];
    const index = idx({ laneNameToId: new Map([["Finance", "L9"]]) });
    const plan = planBundle(bundle, index);
    expect(plan.applyable).toBe(true);
    const createStep = plan.steps.find((s) => s.kind === "create_node");
    if (!createStep || createStep.kind !== "create_node") throw new Error("Expected a create_node step");
    expect(createStep.laneRef).toBeNull();
  });
});

// A suggestion with a custom title + rationale (the `sg` helper hardcodes both).
const sgWith = (
  id: string,
  opOverrides: Partial<SuggestionOp> & { kind: SuggestionOp["kind"] },
  extra: { title?: string; rationale?: string }
): ChatSuggestion => ({
  id,
  group: null,
  title: extra.title ?? id,
  op: op(opOverrides),
  affected_refs: [],
  rationale: extra.rationale ?? "",
  cited_claim_ids: [],
});

describe("reasonForSuggestion", () => {
  it("uses the rationale, stripping [[kind:uuid]] mentions to readable text", () => {
    const s = sgWith("a", { kind: "relabel_node", node_ref: "N1", new_label: "X" }, {
      rationale: "Per [[claim:11111111-1111-1111-1111-111111111111]], rename [[node:22222222-2222-2222-2222-222222222222]].",
    });
    const reason = reasonForSuggestion(s);
    expect(reason).not.toMatch(/\[\[/); // no raw mention markup survives
    expect(reason).toContain("a cited source");
    expect(reason).toContain("this step");
  });

  it("falls back to 'Applied AI suggestion: <title>' (title also stripped) when rationale is empty", () => {
    const s = sgWith("a", { kind: "relabel_node", node_ref: "N1", new_label: "X" }, {
      title: "Rename [[node:22222222-2222-2222-2222-222222222222]]",
      rationale: "",
    });
    const reason = reasonForSuggestion(s);
    expect(reason).toMatch(/^Applied AI suggestion: Rename this step$/);
  });

  it("caps the stored reason at the backend's 2000-char max_length", () => {
    const s = sgWith("a", { kind: "relabel_node", node_ref: "N1", new_label: "X" }, {
      rationale: "x".repeat(5000),
    });
    const reason = reasonForSuggestion(s);
    expect(reason).toHaveLength(2000);
    expect(reason.endsWith("…")).toBe(true);
    expect(reason.slice(0, -1)).toBe("x".repeat(1999));
  });
});

describe("planBundle reason threading", () => {
  it("attaches the suggestion's reason to update_node steps", () => {
    const bundle = bundleSuggestions([
      sgWith("a", { kind: "relabel_node", node_ref: "N1", new_label: "Receive PO" }, {
        rationale: "Matches the source wording.",
      }),
    ])[0];
    const step = planBundle(bundle, idx()).steps[0];
    if (step.kind !== "update_node") throw new Error("expected update_node step");
    expect(step.reason).toBe("Matches the source wording.");
  });

  it("attaches the reason to update_edge_label and update_lane steps", () => {
    const edgePlan = planBundle(
      bundleSuggestions([
        sgWith("e", { kind: "relabel_edge", edge_ref: "E1", new_label: "if approved" }, { rationale: "Branch is conditional." }),
      ])[0],
      idx()
    );
    const edgeStep = edgePlan.steps[0];
    if (edgeStep.kind !== "update_edge_label") throw new Error("expected update_edge_label step");
    expect(edgeStep.reason).toBe("Branch is conditional.");

    const lanePlan = planBundle(
      bundleSuggestions([
        sgWith("l", { kind: "rename_lane", lane_ref: "L1", name: "Operations" }, { rationale: "Owner is Ops." }),
      ])[0],
      idx()
    );
    const laneStep = lanePlan.steps[0];
    if (laneStep.kind !== "update_lane") throw new Error("expected update_lane step");
    expect(laneStep.reason).toBe("Owner is Ops.");
  });

  it("gives each suggestion in a grouped bundle its own reason", () => {
    // Two suggestions of different kinds, grouped, with distinct rationales — a
    // regression that reused the first suggestion's reason for the whole bundle
    // would be caught here.
    const a = { ...sgWith("a", { kind: "relabel_node", node_ref: "N1", new_label: "Receive PO" }, { rationale: "Reason A." }), group: "g1" };
    const b = { ...sgWith("b", { kind: "relabel_edge", edge_ref: "E1", new_label: "if approved" }, { rationale: "Reason B." }), group: "g1" };
    const bundle = bundleSuggestions([a, b])[0];
    expect(bundle.suggestions).toHaveLength(2);
    const plan = planBundle(bundle, idx());
    const nodeStep = plan.steps.find((s) => s.kind === "update_node");
    const edgeStep = plan.steps.find((s) => s.kind === "update_edge_label");
    if (nodeStep?.kind !== "update_node" || edgeStep?.kind !== "update_edge_label") {
      throw new Error("expected one update_node and one update_edge_label step");
    }
    expect(nodeStep.reason).toBe("Reason A.");
    expect(edgeStep.reason).toBe("Reason B.");
  });
});
