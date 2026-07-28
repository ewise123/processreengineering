import { describe, it, expect } from "vitest";
import {
  deleteActionLabel,
  deleteActionDescription,
  DELETE_LANE_DESCRIPTION,
  REASON_PROMPT_DESCRIPTION,
} from "./delete-reason";

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
  it("falls through to the singular on an empty selection", () => {
    // Not a case the UI reaches — the delete handlers return early on an empty
    // selection. Pinned so the fall-through is a decision, not an accident.
    expect(deleteActionLabel({ nodes: 0, edges: 0 })).toBe("Delete step");
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

describe("prompt copy makes one promise", () => {
  /** The trailing "…saved to the change log." sentence of a description. */
  const recordedSentence = (copy: string) => copy.split(". ").slice(-1)[0];

  it("ends every delete description with the same recorded-to-the-log sentence", () => {
    // Derived from one description rather than restated, so this fails if the
    // three copies drift apart — which is the whole risk of having three.
    const shared = recordedSentence(deleteActionDescription({ nodes: 1, edges: 0 }));
    expect(shared).toContain("change log");
    expect(recordedSentence(deleteActionDescription({ nodes: 0, edges: 1 }))).toBe(shared);
    expect(recordedSentence(DELETE_LANE_DESCRIPTION)).toBe(shared);
  });

  it("makes the same promise in the non-destructive default copy", () => {
    // Worded differently on purpose (a plain edit has nothing to warn about),
    // so this pins the promise, not the phrasing.
    expect(REASON_PROMPT_DESCRIPTION).toContain("change log");
  });
});
