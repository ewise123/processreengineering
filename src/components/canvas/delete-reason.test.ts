import { describe, it, expect } from "vitest";
import { deleteActionLabel, deleteActionDescription } from "./delete-reason";

describe("deleteActionLabel", () => {
  it("names a single step and a single connection", () => {
    expect(deleteActionLabel({ nodes: 1, edges: 0 })).toBe("Delete step");
    expect(deleteActionLabel({ nodes: 0, edges: 1 })).toBe("Delete connection");
  });
  it("pluralizes a homogeneous multi-selection", () => {
    expect(deleteActionLabel({ nodes: 3, edges: 0 })).toBe("Delete 3 steps");
    expect(deleteActionLabel({ nodes: 0, edges: 2 })).toBe("Delete 2 connections");
  });
  it("collapses a mixed selection to a total count of items", () => {
    expect(deleteActionLabel({ nodes: 2, edges: 3 })).toBe("Delete 5 items");
    expect(deleteActionLabel({ nodes: 1, edges: 1 })).toBe("Delete 2 items");
  });
});

describe("deleteActionDescription", () => {
  it("warns that deleting steps also removes their connections", () => {
    expect(deleteActionDescription({ nodes: 1, edges: 0 })).toContain("connections to it");
    expect(deleteActionDescription({ nodes: 2, edges: 3 })).toContain("connections to it");
  });
  it("does not claim an edge-only delete removes anything else", () => {
    const copy = deleteActionDescription({ nodes: 0, edges: 1 });
    expect(copy).toContain("removes the connection");
    expect(copy).not.toContain("connections to it");
  });
  it("always says the reason is recorded", () => {
    expect(deleteActionDescription({ nodes: 1, edges: 0 })).toContain("change log");
    expect(deleteActionDescription({ nodes: 0, edges: 1 })).toContain("change log");
  });
});
