import { describe, it, expect } from "vitest";
import { isBacktrack, deriveLoopSides, BACKTRACK_DEADZONE_PX } from "./backtrack";

const later = { x: 400, w: 120 };   // center 460
const earlier = { x: 0, w: 120 };   // center 60
const target = { y: 100, h: 60 };   // top half y<130, bottom half y>=130

describe("isBacktrack", () => {
  it("is true when the target sits clearly left of the source", () => {
    expect(isBacktrack(later, earlier)).toBe(true);
  });
  it("is false when the target sits to the right", () => {
    expect(isBacktrack(earlier, later)).toBe(false);
  });
  it("is false inside the dead-zone (near-vertical stack)", () => {
    const a = { x: 0, w: 100 };               // center 50
    const b = { x: -10, w: 100 };             // center 40, only 10 left < 24
    expect(isBacktrack(a, b)).toBe(false);
    expect(BACKTRACK_DEADZONE_PX).toBe(24);
  });
});

describe("deriveLoopSides", () => {
  it("top handle + drop in top half => top/top", () => {
    expect(deriveLoopSides("top", 110, target)).toEqual({ sourceSide: "top", targetSide: "top" });
  });
  it("bottom handle + drop in bottom half => bottom/bottom", () => {
    expect(deriveLoopSides("bottom", 150, target)).toEqual({ sourceSide: "bottom", targetSide: "bottom" });
  });
  it("left/right handle defaults the source face to bottom", () => {
    expect(deriveLoopSides("left", 110, target)).toEqual({ sourceSide: "bottom", targetSide: "top" });
    expect(deriveLoopSides("right", 150, target)).toEqual({ sourceSide: "bottom", targetSide: "bottom" });
  });
});
