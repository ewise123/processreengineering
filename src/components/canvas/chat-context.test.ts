import { describe, it, expect } from "vitest";
import { selectionToContextRefs, selectionChips } from "./chat-context";

const NODE = { id: "n1", kind: "node" as const, name: "Review Invoice" };
const EDGE = { id: "e1", kind: "edge" as const };

describe("selectionToContextRefs", () => {
  it("returns empty for no selection", () => {
    expect(selectionToContextRefs([])).toEqual([]);
  });
  it("maps each selected object to a ref (multi-select)", () => {
    expect(selectionToContextRefs([NODE, EDGE])).toEqual([
      { kind: "node", id: "n1" },
      { kind: "edge", id: "e1" },
    ]);
  });
});

describe("selectionChips", () => {
  const labelById = new Map([["n1", "Review Invoice"]]);
  it("returns empty for no selection", () => {
    expect(selectionChips([], labelById)).toEqual([]);
  });
  it("labels node chips from the map and edges generically", () => {
    expect(selectionChips([NODE, EDGE], labelById)).toEqual([
      { kind: "node", id: "n1", label: "Review Invoice" },
      { kind: "edge", id: "e1", label: "transition" },
    ]);
  });
  it("falls back to the node's own name when not in the label map", () => {
    expect(
      selectionChips([{ id: "n9", kind: "node", name: "Orphan" }], new Map())
    ).toEqual([{ kind: "node", id: "n9", label: "Orphan" }]);
  });
});
