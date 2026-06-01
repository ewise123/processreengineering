import { describe, expect, it } from "vitest";

import { isEdgeProposed, placeProposedStep } from "./ai-edit";

describe("placeProposedStep", () => {
  it("places the new step downstream (to the right) of the source", () => {
    const pos = placeProposedStep({ x: 100, relativeY: 30, w: 170 });
    expect(pos.x).toBe(100 + 170 + 80);
    expect(pos.relativeY).toBe(30);
  });

  it("accepts a custom gap", () => {
    expect(placeProposedStep({ x: 0, relativeY: 0, w: 100 }, 40).x).toBe(140);
  });
});

describe("isEdgeProposed", () => {
  it("is true when either endpoint is ai-proposed", () => {
    expect(isEdgeProposed({ aiProposed: false }, { aiProposed: true })).toBe(true);
    expect(isEdgeProposed({ aiProposed: true }, { aiProposed: false })).toBe(true);
  });
  it("is false when neither endpoint is ai-proposed", () => {
    expect(isEdgeProposed({ aiProposed: false }, { aiProposed: false })).toBe(false);
    expect(isEdgeProposed(undefined, undefined)).toBe(false);
  });
});
