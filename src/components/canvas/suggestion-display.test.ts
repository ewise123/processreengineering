import { describe, expect, it } from "vitest";

import type { ChatSuggestion, SuggestionOp } from "@/lib/types";
import {
  bundleNewNames,
  groundingChip,
  isProposalGrounded,
  isTmpRef,
  laneReassignmentTarget,
  opPayload,
  opTarget,
  renameTransition,
  suggestedChangesSuffix,
} from "./suggestion-display";

const op = (o: Partial<SuggestionOp> & { kind: SuggestionOp["kind"] }): SuggestionOp => o as SuggestionOp;

const suggestion = (o: Partial<ChatSuggestion> & { op: SuggestionOp }): ChatSuggestion =>
  ({ id: "s", title: "", rationale: "", affected_refs: [], cited_claim_ids: [], ...o }) as ChatSuggestion;

describe("isTmpRef", () => {
  it("flags tmp and decompose sub refs, not real uuids", () => {
    expect(isTmpRef("tmp:1")).toBe(true);
    expect(isTmpRef("abc::sub0")).toBe(true);
    expect(isTmpRef("019ed21f-e94b-7da1-b634-69982110e44f")).toBe(false);
    expect(isTmpRef(null)).toBe(false);
  });
});

describe("opTarget", () => {
  it("links the node for node-acting ops, without repeating the verb", () => {
    expect(opTarget(op({ kind: "describe_node", node_ref: "N-1" }))).toBe("[[node:N-1]]");
    expect(opTarget(op({ kind: "relabel_node", node_ref: "N-1" }))).toBe("[[node:N-1]]");
    expect(opTarget(op({ kind: "remove_node", node_ref: "N-1" }))).toBe("[[node:N-1]]");
  });

  it("links the edge for edge-acting ops", () => {
    expect(opTarget(op({ kind: "relabel_edge", edge_ref: "E-1" }))).toBe("[[edge:E-1]]");
    expect(opTarget(op({ kind: "remove_edge", edge_ref: "E-1" }))).toBe("[[edge:E-1]]");
  });

  it("shows both endpoints for add_edge, with tmp endpoints as a [[new:…]] chip", () => {
    expect(opTarget(op({ kind: "add_edge", from_ref: "N-1", to_ref: "N-2" }))).toBe(
      "[[node:N-1]] → [[node:N-2]]"
    );
    expect(opTarget(op({ kind: "add_edge", from_ref: "N-1", to_ref: "tmp:1" }))).toBe(
      "[[node:N-1]] → [[new:tmp:1]]"
    );
  });

  it("links the lane for rename_lane and falls back for add_lane/add_node-without-anchor", () => {
    expect(opTarget(op({ kind: "rename_lane", lane_ref: "L-1" }))).toBe("[[lane:L-1]]");
    expect(opTarget(op({ kind: "add_lane", name: "Ops" }))).toBeNull();
    expect(opTarget(op({ kind: "add_node", new_label: "X" }))).toBeNull();
    expect(opTarget(op({ kind: "add_node", new_label: "X", near_node_ref: "N-1" }))).toBe(
      "after [[node:N-1]]"
    );
  });
});

describe("opPayload", () => {
  it("previews the proposed value per kind", () => {
    expect(opPayload(op({ kind: "describe_node", description: "Logs the invoice." }))).toEqual({
      value: "Logs the invoice.",
      hasMention: false,
    });
    expect(opPayload(op({ kind: "relabel_node", new_label: "Intake invoice" }))).toEqual({
      value: "Intake invoice",
      hasMention: false,
    });
    expect(opPayload(op({ kind: "rename_lane", name: "Procurement" }))).toEqual({
      value: "Procurement",
      hasMention: false,
    });
    expect(opPayload(op({ kind: "move_to_lane", node_ref: "N-1", lane_ref: "L-2" }))).toEqual({
      value: "→ [[lane:L-2]]",
      hasMention: true,
    });
  });

  it("previews a move into a not-yet-created lane as a [[new:…]] chip", () => {
    expect(opPayload(op({ kind: "move_to_lane", node_ref: "N-1", lane_ref: "tmp:2" }))).toEqual({
      value: "→ [[new:tmp:2]]",
      hasMention: true,
    });
  });

  it("returns null when there is no value to show", () => {
    expect(opPayload(op({ kind: "remove_node", node_ref: "N-1" }))).toBeNull();
    expect(opPayload(op({ kind: "add_edge", from_ref: "N-1", to_ref: "N-2" }))).toBeNull();
  });
});

describe("renameTransition", () => {
  it("freezes before → after for the rename family", () => {
    expect(renameTransition(op({ kind: "relabel_node", new_label: "Receive supplier invoice" }), "Receive invoice via email or mail"))
      .toEqual({ before: "Receive invoice via email or mail", after: "Receive supplier invoice" });
    expect(renameTransition(op({ kind: "rename_lane", name: "Procurement" }), "Finance"))
      .toEqual({ before: "Finance", after: "Procurement" });
    expect(renameTransition(op({ kind: "relabel_edge", new_label: "if rejected" }), "if approved"))
      .toEqual({ before: "if approved", after: "if rejected" });
  });

  it("uses a placeholder when there is no prior label (e.g. an unlabeled edge)", () => {
    expect(renameTransition(op({ kind: "relabel_edge", new_label: "if duplicate" }), null))
      .toEqual({ before: "(no label)", after: "if duplicate" });
    expect(renameTransition(op({ kind: "relabel_edge", new_label: "if duplicate" }), "  "))
      .toEqual({ before: "(no label)", after: "if duplicate" });
  });

  it("returns null for non-rename ops (they keep the live mention + value preview)", () => {
    expect(renameTransition(op({ kind: "describe_node", description: "x" }), "anything")).toBeNull();
    expect(renameTransition(op({ kind: "move_to_lane", node_ref: "N-1", lane_ref: "L-2" }), "anything")).toBeNull();
  });
});

describe("bundleNewNames", () => {
  it("maps every producer's tmp ref to its planned name", () => {
    const names = bundleNewNames([
      suggestion({ op: op({ kind: "add_node", temp_id: "tmp:1", new_label: "Approve invoice" }) }),
      suggestion({ op: op({ kind: "add_lane", temp_id: "tmp:2", name: "Approvals" }) }),
      suggestion({
        op: op({
          kind: "decompose",
          node_ref: "N-9",
          sub_steps: [
            { proposed_name: "Check total", proposed_type: "task" },
            { proposed_name: "Sign off", proposed_type: "task" },
          ],
        }),
      }),
    ]);
    expect(names.get("tmp:1")).toBe("Approve invoice");
    expect(names.get("tmp:2")).toBe("Approvals");
    expect(names.get("N-9::sub0")).toBe("Check total");
    expect(names.get("N-9::sub1")).toBe("Sign off");
  });

  it("falls back to a generic name when a producer has no label", () => {
    const names = bundleNewNames([
      suggestion({ op: op({ kind: "add_node", temp_id: "tmp:1" }) }),
      suggestion({ op: op({ kind: "add_lane", temp_id: "tmp:2" }) }),
    ]);
    expect(names.get("tmp:1")).toBe("new step");
    expect(names.get("tmp:2")).toBe("new lane");
  });

  it("ignores ops that create nothing", () => {
    const names = bundleNewNames([
      suggestion({ op: op({ kind: "relabel_node", node_ref: "N-1", new_label: "X" }) }),
    ]);
    expect(names.size).toBe(0);
  });
});

describe("new op kinds → display", () => {
  it("change_node_type targets node + previews type", () => {
    expect(opTarget({ kind: "change_node_type", node_ref: "N1", node_type: "gateway_exclusive" })).toBe("[[node:N1]]");
    expect(opPayload({ kind: "change_node_type", node_ref: "N1", node_type: "gateway_exclusive" }))
      .toEqual({ value: "gateway_exclusive", hasMention: false });
  });
  it("remove_lane targets the lane", () => {
    expect(opTarget({ kind: "remove_lane", lane_ref: "L1" })).toBe("[[lane:L1]]");
  });
  it("set_edge_condition targets edge + previews condition", () => {
    expect(opTarget({ kind: "set_edge_condition", edge_ref: "E1", condition_text: "amt > 10000" })).toBe("[[edge:E1]]");
    expect(opPayload({ kind: "set_edge_condition", edge_ref: "E1", condition_text: "amt > 10000" }))
      .toEqual({ value: "amt > 10000", hasMention: false });
  });
});

describe("proposal grounding", () => {
  it("grounded when the suggestion cites at least one claim", () => {
    expect(isProposalGrounded({ cited_claim_ids: ["11111111-1111-1111-1111-111111111111"] })).toBe(true);
  });
  it("not grounded when no claims are cited", () => {
    expect(isProposalGrounded({ cited_claim_ids: [] })).toBe(false);
  });
});

describe("groundingChip", () => {
  const s = (over: Partial<ChatSuggestion>): ChatSuggestion =>
    ({ id: "x", title: "t", op: op({ kind: "add_node" }), affected_refs: [],
       rationale: "", cited_claim_ids: [], ...over }) as ChatSuggestion;

  it("returns null when the change cites a claim (supported)", () => {
    expect(groundingChip(s({ cited_claim_ids: ["c1" as never], origin: "ai_volunteered" }))).toBeNull();
  });
  it("labels a user-directed uncited change 'Not in your sources'", () => {
    expect(groundingChip(s({ origin: "user_directed" }))?.label).toBe("Not in your sources");
  });
  it("labels an AI-volunteered uncited change as an AI suggestion", () => {
    expect(groundingChip(s({ origin: "ai_volunteered" }))?.label).toBe("AI suggestion · not in your sources");
  });
  it("defaults an uncited change with no origin to 'Not in your sources'", () => {
    expect(groundingChip(s({}))?.label).toBe("Not in your sources");
  });
});

describe("suggestedChangesSuffix", () => {
  it("always shows the applied fraction", () => {
    expect(suggestedChangesSuffix(3, 0)).toBe("0 of 3 applied");
    expect(suggestedChangesSuffix(3, 1)).toBe("1 of 3 applied");
    expect(suggestedChangesSuffix(3, 3)).toBe("3 of 3 applied");
    expect(suggestedChangesSuffix(1, 0)).toBe("0 of 1 applied");
  });
});

describe("laneReassignmentTarget", () => {
  const lanes = [{ id: "L2", order_index: 1 }, { id: "L1", order_index: 0 }, { id: "L3", order_index: 2 }];
  it("returns the first remaining lane by order_index", () => {
    expect(laneReassignmentTarget({ kind: "remove_lane", lane_ref: "L3" }, lanes)).toBe("L1");
  });
  it("returns null when the removed lane is the only lane", () => {
    expect(laneReassignmentTarget({ kind: "remove_lane", lane_ref: "L1" }, [{ id: "L1", order_index: 0 }])).toBeNull();
  });
  it("returns null for non-remove_lane ops", () => {
    expect(laneReassignmentTarget({ kind: "relabel_node", node_ref: "N1", new_label: "x" }, lanes)).toBeNull();
  });
});
