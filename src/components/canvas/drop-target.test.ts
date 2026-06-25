import { describe, it, expect } from "vitest";
import { distanceToRect, pickDropTargetId } from "./drop-target";

const A = { id: "A", x: 0, y: 0, w: 100, h: 60 };       // covers (0..100, 0..60)
const B = { id: "B", x: 200, y: 0, w: 100, h: 60 };     // covers (200..300, 0..60)

describe("distanceToRect", () => {
  it("is 0 inside the rect", () => {
    expect(distanceToRect(50, 30, A)).toBe(0);
  });
  it("measures the gap to the nearest edge", () => {
    expect(distanceToRect(110, 30, A)).toBe(10); // 10px right of the right edge
  });
  it("measures the diagonal gap past a corner", () => {
    expect(distanceToRect(103, 64, A)).toBeCloseTo(5); // 3 right, 4 below -> 5
  });
});

describe("pickDropTargetId", () => {
  it("returns the node the point sits inside", () => {
    expect(pickDropTargetId(50, 30, [A, B])).toBe("A");
  });
  it("snaps to a node just outside its edge within tolerance", () => {
    expect(pickDropTargetId(110, 30, [A, B], 20)).toBe("A"); // 10px out, tol 20
  });
  it("returns null when nothing is within tolerance", () => {
    expect(pickDropTargetId(150, 200, [A, B], 20)).toBeNull();
  });
  it("picks the nearer node when the point sits between two", () => {
    // 160 is 60px from A's right edge (x=100) and 40px from B's left edge (x=200).
    expect(pickDropTargetId(160, 30, [A, B], 100)).toBe("B");
  });
});
