import { describe, it, expect } from "vitest";
import { selectionToContextRefs, selectionChips } from "./chat-context";

const NODE = { id: "n1", kind: "node" as const, name: "Review Invoice" };
const EDGE = { id: "e1", kind: "edge" as const };

describe("selectionToContextRefs", () => {
  it("returns empty for null selection", () => {
    expect(selectionToContextRefs(null)).toEqual([]);
  });
  it("maps a node selection to one node ref", () => {
    expect(selectionToContextRefs(NODE)).toEqual([{ kind: "node", id: "n1" }]);
  });
  it("maps an edge selection to one edge ref", () => {
    expect(selectionToContextRefs(EDGE)).toEqual([{ kind: "edge", id: "e1" }]);
  });
});

describe("selectionChips", () => {
  const labelById = new Map([["n1", "Review Invoice"]]);
  it("returns empty for null selection", () => {
    expect(selectionChips(null, labelById)).toEqual([]);
  });
  it("labels a node chip from the map, falling back to its own name", () => {
    expect(selectionChips(NODE, labelById)).toEqual([
      { kind: "node", id: "n1", label: "Review Invoice" },
    ]);
  });
  it("labels an edge chip generically when no name is known", () => {
    expect(selectionChips(EDGE, labelById)).toEqual([
      { kind: "edge", id: "e1", label: "transition" },
    ]);
  });
});
