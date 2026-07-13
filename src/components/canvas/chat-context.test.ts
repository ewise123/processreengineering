import { describe, it, expect } from "vitest";
import { selectionToContextRefs, selectionChips, buildSendContext } from "./chat-context";

const NODE = { id: "n1", kind: "node" as const, name: "Review Invoice" };
const EDGE = { id: "e1", kind: "edge" as const };

describe("selectionToContextRefs", () => {
  it("returns empty for no selection", () => {
    expect(selectionToContextRefs([])).toEqual([]);
  });
  it("keeps only node refs (edges are not chat context)", () => {
    expect(selectionToContextRefs([NODE, EDGE])).toEqual([{ kind: "node", id: "n1" }]);
  });
});

describe("selectionChips", () => {
  const labelById = new Map([["n1", "Review Invoice"]]);
  it("returns empty for no selection", () => {
    expect(selectionChips([], labelById)).toEqual([]);
  });
  it("shows node chips only, labeled from the map", () => {
    expect(selectionChips([NODE, EDGE], labelById)).toEqual([
      { kind: "node", id: "n1", label: "Review Invoice" },
    ]);
  });
  it("falls back to the node's own name when not in the label map", () => {
    expect(selectionChips([{ id: "n9", kind: "node", name: "Orphan" }], new Map())).toEqual([
      { kind: "node", id: "n9", label: "Orphan" },
    ]);
  });
});

describe("buildSendContext", () => {
  const labelById = new Map([["n1", "Review Invoice"]]);

  it("returns empty refs and undefined chips/note when nothing is pending (subsequent messages with no new selection)", () => {
    expect(buildSendContext([], labelById)).toEqual({
      refs: [],
      chips: undefined,
      note: undefined,
    });
  });

  it("builds refs, chips, and a joined note from the pending selection", () => {
    expect(buildSendContext([NODE], labelById)).toEqual({
      refs: [{ kind: "node", id: "n1" }],
      chips: [{ kind: "node", id: "n1", label: "Review Invoice" }],
      note: "Review Invoice",
    });
  });

  it("joins multiple chip labels into the note and drops edges from refs/chips", () => {
    const other = { id: "n2", kind: "node" as const, name: "Approve" };
    expect(buildSendContext([NODE, other, EDGE], labelById)).toEqual({
      refs: [
        { kind: "node", id: "n1" },
        { kind: "node", id: "n2" },
      ],
      chips: [
        { kind: "node", id: "n1", label: "Review Invoice" },
        { kind: "node", id: "n2", label: "Approve" },
      ],
      note: "Review Invoice, Approve",
    });
  });

  it("does not mutate or depend on any prior call's result (no accumulation across calls)", () => {
    const first = buildSendContext([NODE], labelById);
    const second = buildSendContext([], labelById);
    expect(first.refs).toEqual([{ kind: "node", id: "n1" }]);
    expect(second.refs).toEqual([]);
  });
});
