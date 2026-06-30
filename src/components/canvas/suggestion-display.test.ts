import { describe, expect, it } from "vitest";

import type { SuggestionOp } from "@/lib/types";
import { isTmpRef, opPayload, opTarget, renameTransition } from "./suggestion-display";

const op = (o: Partial<SuggestionOp> & { kind: SuggestionOp["kind"] }): SuggestionOp =>
  ({ kind: o.kind, ...o }) as SuggestionOp;

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

  it("shows both endpoints for add_edge, with tmp endpoints as plain text", () => {
    expect(opTarget(op({ kind: "add_edge", from_ref: "N-1", to_ref: "N-2" }))).toBe(
      "[[node:N-1]] → [[node:N-2]]"
    );
    expect(opTarget(op({ kind: "add_edge", from_ref: "N-1", to_ref: "tmp:1" }))).toBe(
      "[[node:N-1]] → the new step"
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
